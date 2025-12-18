import type { CoreMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import { logger } from "@/utils/logger";
import type {
  RALState,
  RALStatus,
  PendingDelegation,
  CompletedDelegation,
  QueuedInjection,
} from "./types";

export class RALRegistry {
  private static instance: RALRegistry;
  private states: Map<string, RALState> = new Map();
  private delegationToRal: Map<string, string> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();

  private constructor() {}

  static getInstance(): RALRegistry {
    if (!RALRegistry.instance) {
      RALRegistry.instance = new RALRegistry();
    }
    return RALRegistry.instance;
  }

  /**
   * Create a new RAL entry for an agent
   */
  create(agentPubkey: string, originalTriggeringEventId?: string): string {
    const id = crypto.randomUUID();
    const now = Date.now();

    const state: RALState = {
      id,
      agentPubkey,
      messages: [],
      pendingDelegations: [],
      completedDelegations: [],
      queuedInjections: [],
      status: "executing",
      createdAt: now,
      lastActivityAt: now,
      originalTriggeringEventId,
    };

    this.states.set(agentPubkey, state);

    logger.debug("[RALRegistry] Created RAL", {
      ralId: id.substring(0, 8),
      agentPubkey: agentPubkey.substring(0, 8),
      originalTriggeringEventId: originalTriggeringEventId?.substring(0, 8),
    });

    return id;
  }

  /**
   * Get RAL state by agent pubkey
   */
  getStateByAgent(agentPubkey: string): RALState | undefined {
    return this.states.get(agentPubkey);
  }

  /**
   * Get RAL ID for a delegation event ID
   */
  getRalIdForDelegation(delegationEventId: string): string | undefined {
    return this.delegationToRal.get(delegationEventId);
  }

  /**
   * Update RAL status
   */
  setStatus(agentPubkey: string, status: RALStatus): void {
    const state = this.states.get(agentPubkey);
    if (state) {
      state.status = status;
      state.lastActivityAt = Date.now();
    }
  }

  /**
   * Save/update messages for the current execution (RAL is single source of truth)
   */
  saveMessages(agentPubkey: string, messages: CoreMessage[]): void {
    const state = this.states.get(agentPubkey);
    if (!state) {
      logger.warn("[RALRegistry] No RAL found to save messages", {
        agentPubkey: agentPubkey.substring(0, 8),
      });
      return;
    }

    state.messages = messages;
    state.lastActivityAt = Date.now();

    logger.debug("[RALRegistry] Saved RAL messages", {
      ralId: state.id.substring(0, 8),
      messageCount: messages.length,
    });
  }

  /**
   * Get messages for the current execution (returns empty if no RAL or no messages saved)
   */
  getMessages(agentPubkey: string): CoreMessage[] {
    const state = this.states.get(agentPubkey);
    if (!state || state.messages.length === 0) return [];
    return [...state.messages];
  }

  /**
   * Check if RAL has saved messages (for determining whether to rebuild or reuse)
   */
  hasMessages(agentPubkey: string): boolean {
    const state = this.states.get(agentPubkey);
    return !!state && state.messages.length > 0;
  }

  /**
   * Save messages and pending delegations (called when RAL pauses)
   */
  saveState(
    agentPubkey: string,
    messages: CoreMessage[],
    pendingDelegations: PendingDelegation[]
  ): void {
    const state = this.states.get(agentPubkey);
    if (!state) {
      logger.warn("[RALRegistry] No RAL found to save state", {
        agentPubkey: agentPubkey.substring(0, 8),
      });
      return;
    }

    state.messages = messages;
    state.pendingDelegations = pendingDelegations;
    state.status = "paused";
    state.lastActivityAt = Date.now();

    // Register delegation event ID -> RAL ID mappings
    for (const d of pendingDelegations) {
      this.delegationToRal.set(d.eventId, state.id);
    }

    logger.debug("[RALRegistry] Saved RAL state", {
      ralId: state.id.substring(0, 8),
      messageCount: messages.length,
      pendingCount: pendingDelegations.length,
    });
  }

  /**
   * Record a delegation completion
   */
  recordCompletion(
    agentPubkey: string,
    completion: CompletedDelegation
  ): void {
    const state = this.states.get(agentPubkey);
    if (!state) return;

    state.completedDelegations.push(completion);
    state.lastActivityAt = Date.now();

    // Remove from pending
    state.pendingDelegations = state.pendingDelegations.filter(
      (p) => p.eventId !== completion.eventId
    );

    logger.debug("[RALRegistry] Recorded completion", {
      ralId: state.id.substring(0, 8),
      completedEventId: completion.eventId.substring(0, 8),
      remainingPending: state.pendingDelegations.length,
    });
  }

  /**
   * Queue an event for injection
   */
  queueEvent(agentPubkey: string, event: NDKEvent): void {
    const state = this.states.get(agentPubkey);
    if (!state) {
      logger.warn("[RALRegistry] Cannot queue event - no RAL state", {
        agentPubkey: agentPubkey.substring(0, 8),
        eventId: event.id?.substring(0, 8),
      });
      return;
    }

    state.queuedInjections.push({
      type: "user",
      content: event.content,
      eventId: event.id,
      queuedAt: Date.now(),
    });

    // Add trace event for queuing (only if span is still recording)
    const activeSpan = trace.getActiveSpan();
    if (activeSpan?.isRecording()) {
      activeSpan.addEvent("ral.event_queued", {
        "ral.id": state.id,
        "ral.status": state.status,
        "event.id": event.id || "",
        "queue.size": state.queuedInjections.length,
        "agent.pubkey": agentPubkey,
      });
    }

    logger.debug("[RALRegistry] Queued event for injection", {
      ralId: state.id.substring(0, 8),
      eventId: event.id?.substring(0, 8),
      queueSize: state.queuedInjections.length,
      ralStatus: state.status,
    });
  }

  /**
   * Queue a system message for injection
   */
  queueSystemMessage(agentPubkey: string, content: string): void {
    const state = this.states.get(agentPubkey);
    if (!state) {
      logger.warn("[RALRegistry] Cannot queue system message - no RAL state", {
        agentPubkey: agentPubkey.substring(0, 8),
        contentLength: content.length,
      });
      return;
    }

    state.queuedInjections.push({
      type: "system",
      content,
      queuedAt: Date.now(),
    });

    // Add trace event for queuing (only if span is still recording)
    const activeSpan = trace.getActiveSpan();
    if (activeSpan?.isRecording()) {
      activeSpan.addEvent("ral.system_message_queued", {
        "ral.id": state.id,
        "ral.status": state.status,
        "message.length": content.length,
        "queue.size": state.queuedInjections.length,
        "agent.pubkey": agentPubkey,
      });
    }

    logger.debug("[RALRegistry] Queued system message for injection", {
      ralId: state.id.substring(0, 8),
      contentLength: content.length,
      queueSize: state.queuedInjections.length,
    });
  }

  /**
   * Check if an event is still queued
   */
  eventStillQueued(agentPubkey: string, eventId: string): boolean {
    const state = this.states.get(agentPubkey);
    if (!state) return false;
    return state.queuedInjections.some((i) => i.eventId === eventId);
  }

  /**
   * Get newly queued injections and persist them to state.messages.
   * Only returns items that were just moved from queue - already-persisted items
   * are already in state.messages and will be included on recursion via getMessages().
   */
  getAndPersistInjections(agentPubkey: string): QueuedInjection[] {
    const state = this.states.get(agentPubkey);
    if (!state) return [];

    // Only process newly queued items
    if (state.queuedInjections.length === 0) {
      return [];
    }

    const newInjections = [...state.queuedInjections];
    state.queuedInjections = [];

    // Append to messages so they're included on recursion via getMessages()
    for (const injection of newInjections) {
      state.messages.push({
        role: injection.type as "user" | "system",
        content: injection.content,
      });
    }

    // Add trace event (only if span is still recording)
    const activeSpan = trace.getActiveSpan();
    if (activeSpan?.isRecording()) {
      activeSpan.addEvent("ral.injections_persisted", {
        "ral.id": state.id,
        "injection.count": newInjections.length,
        "injection.types": newInjections.map((i) => i.type).join(","),
        "total_messages": state.messages.length,
        "agent.pubkey": agentPubkey,
      });
    }

    logger.debug("[RALRegistry] Persisted injections to messages", {
      ralId: state.id.substring(0, 8),
      newCount: newInjections.length,
      totalMessages: state.messages.length,
    });

    return newInjections;
  }


  /**
   * Swap a queued user event with a system message
   */
  swapQueuedEvent(
    agentPubkey: string,
    eventId: string,
    systemContent: string
  ): void {
    const state = this.states.get(agentPubkey);
    if (!state) {
      logger.warn("[RALRegistry] Cannot swap event - no RAL state", {
        agentPubkey: agentPubkey.substring(0, 8),
        eventId: eventId.substring(0, 8),
      });
      return;
    }

    const beforeCount = state.queuedInjections.length;

    // Remove the user event
    state.queuedInjections = state.queuedInjections.filter(
      (i) => i.eventId !== eventId
    );

    // Add system message
    state.queuedInjections.push({
      type: "system",
      content: systemContent,
      queuedAt: Date.now(),
    });

    // Add trace event for swap (only if span is still recording)
    const activeSpan = trace.getActiveSpan();
    if (activeSpan?.isRecording()) {
      activeSpan.addEvent("ral.event_swapped_to_system", {
        "ral.id": state.id,
        "event.id": eventId,
        "system_message.length": systemContent.length,
        "queue.before_count": beforeCount,
        "queue.after_count": state.queuedInjections.length,
        "agent.pubkey": agentPubkey,
      });
    }

    logger.debug("[RALRegistry] Swapped user event with system message", {
      ralId: state.id.substring(0, 8),
      eventId: eventId.substring(0, 8),
      systemContentLength: systemContent.length,
    });
  }

  /**
   * Set current tool being executed (for timeout responder context)
   */
  setCurrentTool(agentPubkey: string, toolName: string | undefined): void {
    const state = this.states.get(agentPubkey);
    if (!state) return;

    state.currentTool = toolName;
    state.toolStartedAt = toolName ? Date.now() : undefined;
  }

  /**
   * Register an abort controller for the current tool
   */
  registerAbortController(
    agentPubkey: string,
    controller: AbortController
  ): void {
    this.abortControllers.set(agentPubkey, controller);
  }

  /**
   * Abort current tool execution
   */
  abortCurrentTool(agentPubkey: string): void {
    const controller = this.abortControllers.get(agentPubkey);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(agentPubkey);
      logger.info("[RALRegistry] Aborted current tool", {
        agentPubkey: agentPubkey.substring(0, 8),
      });
    }
  }

  /**
   * Clear RAL state (called on finish_reason: done)
   */
  clear(agentPubkey: string): void {
    const state = this.states.get(agentPubkey);
    if (state) {
      // Clean up delegation mappings
      for (const d of state.pendingDelegations) {
        this.delegationToRal.delete(d.eventId);
      }
      for (const d of state.completedDelegations) {
        this.delegationToRal.delete(d.eventId);
      }
    }

    this.states.delete(agentPubkey);
    this.abortControllers.delete(agentPubkey);

    logger.debug("[RALRegistry] Cleared RAL state", {
      agentPubkey: agentPubkey.substring(0, 8),
    });
  }

  /**
   * Get summary of RAL state for timeout responder
   */
  getStateSummary(agentPubkey: string): string {
    const state = this.states.get(agentPubkey);
    if (!state) return "No active execution";

    const toolInfo = state.currentTool
      ? `Running tool: ${state.currentTool} for ${Date.now() - (state.toolStartedAt || 0)}ms`
      : "Between tool calls";

    const recentMessages = state.messages
      .slice(-4)
      .map((m) => `${m.role}: ${String(m.content).substring(0, 80)}...`)
      .join("\n");

    return `${toolInfo}\n\nRecent context:\n${recentMessages}`;
  }

  /**
   * Find the agent pubkey that is waiting for a delegation response
   * @param delegationEventId The event ID of the delegation
   * @returns The agent pubkey waiting for this delegation, or undefined
   */
  findAgentWaitingForDelegation(delegationEventId: string): string | undefined {
    for (const [agentPubkey, state] of this.states.entries()) {
      if (state.status === "paused") {
        const hasPending = state.pendingDelegations.some(
          (d) => d.eventId === delegationEventId
        );
        if (hasPending) {
          return agentPubkey;
        }
      }
    }
    return undefined;
  }

  /**
   * Check if an agent has a paused RAL waiting for delegations
   */
  hasPausedRal(agentPubkey: string): boolean {
    const state = this.states.get(agentPubkey);
    return state?.status === "paused" && state.pendingDelegations.length > 0;
  }

  /**
   * Check if all pending delegations are complete for an agent
   */
  allDelegationsComplete(agentPubkey: string): boolean {
    const state = this.states.get(agentPubkey);
    if (!state) return false;
    return state.pendingDelegations.length === 0 && state.completedDelegations.length > 0;
  }

  /**
   * Get the paused RAL state for resumption
   * Returns the state only if it's paused and ready to resume
   */
  getStateForResumption(agentPubkey: string): RALState | undefined {
    const state = this.states.get(agentPubkey);
    if (!state || state.status !== "paused") return undefined;
    if (state.pendingDelegations.length > 0) return undefined; // Still waiting
    return state;
  }

  /**
   * Mark RAL as resuming (transitioning from paused to executing)
   */
  markResuming(agentPubkey: string): void {
    const state = this.states.get(agentPubkey);
    if (state) {
      state.status = "executing";
      state.lastActivityAt = Date.now();
      logger.info("[RALRegistry] RAL resuming after delegation completion", {
        ralId: state.id.substring(0, 8),
        agentPubkey: agentPubkey.substring(0, 8),
        completedCount: state.completedDelegations.length,
      });
    }
  }

  /**
   * Get completed delegations for injection into resumed conversation
   */
  getCompletedDelegationsForInjection(agentPubkey: string): CompletedDelegation[] {
    const state = this.states.get(agentPubkey);
    if (!state) return [];
    return [...state.completedDelegations];
  }

  /**
   * Clear completed delegations after they've been injected
   */
  clearCompletedDelegations(agentPubkey: string): void {
    const state = this.states.get(agentPubkey);
    if (state) {
      // Clean up delegation mappings
      for (const d of state.completedDelegations) {
        this.delegationToRal.delete(d.eventId);
      }
      state.completedDelegations = [];
    }
  }
}
