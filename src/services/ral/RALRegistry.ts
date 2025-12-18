import type { CoreMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
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
  create(agentPubkey: string): string {
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
    };

    this.states.set(agentPubkey, state);

    logger.debug("[RALRegistry] Created RAL", {
      ralId: id.substring(0, 8),
      agentPubkey: agentPubkey.substring(0, 8),
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
    if (!state) return;

    state.queuedInjections.push({
      type: "user",
      content: event.content,
      eventId: event.id,
      queuedAt: Date.now(),
    });

    logger.debug("[RALRegistry] Queued event for injection", {
      ralId: state.id.substring(0, 8),
      eventId: event.id?.substring(0, 8),
    });
  }

  /**
   * Queue a system message for injection
   */
  queueSystemMessage(agentPubkey: string, content: string): void {
    const state = this.states.get(agentPubkey);
    if (!state) return;

    state.queuedInjections.push({
      type: "system",
      content,
      queuedAt: Date.now(),
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
   * Get and clear queued injections
   */
  getAndClearQueued(agentPubkey: string): QueuedInjection[] {
    const state = this.states.get(agentPubkey);
    if (!state) return [];

    const injections = [...state.queuedInjections];
    state.queuedInjections = [];
    return injections;
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
    if (!state) return;

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
}
