import type { ModelMessage } from "ai";
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
  private ralIdToAgent: Map<string, string> = new Map(); // Reverse lookup for O(1) agent resolution
  private abortControllers: Map<string, AbortController> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Maximum age for RAL states before cleanup (default: 24 hours) */
  private static readonly STATE_TTL_MS = 24 * 60 * 60 * 1000;
  /** Cleanup interval (default: 1 hour) */
  private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  /** Maximum queue size for injections (prevents DoS) */
  private static readonly MAX_QUEUE_SIZE = 100;

  private constructor() {
    this.startCleanupInterval();
  }

  /**
   * Start periodic cleanup of expired RAL states
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredStates();
    }, RALRegistry.CLEANUP_INTERVAL_MS);

    // Don't prevent process from exiting
    this.cleanupInterval.unref();
  }

  /**
   * Clean up RAL states that have been inactive for too long
   */
  private cleanupExpiredStates(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [agentPubkey, state] of this.states.entries()) {
      if (now - state.lastActivityAt > RALRegistry.STATE_TTL_MS) {
        this.clear(agentPubkey);
        cleanedCount++;
        logger.info("[RALRegistry] Cleaned up expired RAL state", {
          agentPubkey: agentPubkey.substring(0, 8),
          ralId: state.id.substring(0, 8),
          ageHours: Math.round((now - state.lastActivityAt) / (60 * 60 * 1000)),
        });
      }
    }

    if (cleanedCount > 0) {
      logger.info("[RALRegistry] Cleanup complete", {
        cleanedCount,
        remainingStates: this.states.size,
      });
    }
  }

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
    this.ralIdToAgent.set(id, agentPubkey); // Reverse lookup

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
   * Get agent pubkey by RAL ID (O(1) reverse lookup)
   */
  getAgentByRalId(ralId: string): string | undefined {
    return this.ralIdToAgent.get(ralId);
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
  saveMessages(agentPubkey: string, messages: ModelMessage[]): void {
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
  getMessages(agentPubkey: string): ModelMessage[] {
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
    messages: ModelMessage[],
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

    // Enforce queue size limit (drop oldest if full)
    if (state.queuedInjections.length >= RALRegistry.MAX_QUEUE_SIZE) {
      const dropped = state.queuedInjections.shift();
      logger.warn("[RALRegistry] Queue full, dropping oldest event", {
        agentPubkey: agentPubkey.substring(0, 8),
        droppedEventId: dropped?.eventId?.substring(0, 8),
        queueSize: state.queuedInjections.length,
      });
    }

    state.queuedInjections.push({
      role: "user",
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

    // Enforce queue size limit (drop oldest if full)
    if (state.queuedInjections.length >= RALRegistry.MAX_QUEUE_SIZE) {
      const dropped = state.queuedInjections.shift();
      logger.warn("[RALRegistry] Queue full, dropping oldest message", {
        agentPubkey: agentPubkey.substring(0, 8),
        droppedEventId: dropped?.eventId?.substring(0, 8),
        queueSize: state.queuedInjections.length,
      });
    }

    state.queuedInjections.push({
      role: "system",
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
        role: injection.role,
        content: injection.content,
      });
    }

    // Add trace event (only if span is still recording)
    const activeSpan = trace.getActiveSpan();
    if (activeSpan?.isRecording()) {
      activeSpan.addEvent("ral.injections_persisted", {
        "ral.id": state.id,
        "injection.count": newInjections.length,
        "injection.roles": newInjections.map((i) => i.role).join(","),
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
      role: "system",
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

    // Clean up AbortController when tool completes (toolName undefined)
    if (!toolName) {
      this.abortControllers.delete(agentPubkey);
    }
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
      // Clean up reverse lookup
      this.ralIdToAgent.delete(state.id);
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
   * Uses O(1) lookup via delegationToRal and ralIdToAgent maps
   * @param delegationEventId The event ID of the delegation
   * @returns The agent pubkey waiting for this delegation, or undefined
   */
  findAgentWaitingForDelegation(delegationEventId: string): string | undefined {
    // O(1) lookup: delegationEventId -> ralId -> agentPubkey
    const ralId = this.delegationToRal.get(delegationEventId);
    if (!ralId) return undefined;

    const agentPubkey = this.ralIdToAgent.get(ralId);
    if (!agentPubkey) return undefined;

    // Verify the agent is still paused and waiting for this delegation
    const state = this.states.get(agentPubkey);
    if (!state || state.status !== "paused") return undefined;

    const hasPending = state.pendingDelegations.some(
      (d) => d.eventId === delegationEventId
    );
    return hasPending ? agentPubkey : undefined;
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
