import type { ModelMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import { logger } from "@/utils/logger";
import type {
  RALState,
  PendingDelegation,
  CompletedDelegation,
  QueuedInjection,
} from "./types";

export interface RALSummary {
  ralNumber: number;
  ralId: string;
  isStreaming: boolean;
  currentTool?: string;
  /** Messages unique to this RAL (starting from triggering event, excludes shared conversation history) */
  uniqueMessages: ModelMessage[];
  pendingDelegations: Array<{ recipientSlug?: string; prompt: string; eventId: string }>;
  createdAt: number;
  hasPendingDelegations: boolean;
}

export class RALRegistry {
  private static instance: RALRegistry;

  /**
   * RAL states keyed by "agentPubkey:conversationId", value is Map of ralNumber -> RALState
   * This allows multiple concurrent RALs per agent+conversation
   */
  private states: Map<string, Map<number, RALState>> = new Map();

  /** Track next RAL number for each conversation */
  private nextRalNumber: Map<string, number> = new Map();

  /** Maps delegation event ID -> {key, ralNumber} for O(1) lookup */
  private delegationToRal: Map<string, { key: string; ralNumber: number }> = new Map();

  /** Maps RAL ID -> {key, ralNumber} for O(1) reverse lookup */
  private ralIdToLocation: Map<string, { key: string; ralNumber: number }> = new Map();

  /** Abort controllers keyed by "key:ralNumber" */
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

  private makeKey(agentPubkey: string, conversationId: string): string {
    return `${agentPubkey}:${conversationId}`;
  }

  private makeAbortKey(key: string, ralNumber: number): string {
    return `${key}:${ralNumber}`;
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredStates();
    }, RALRegistry.CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  private cleanupExpiredStates(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, rals] of this.states.entries()) {
      for (const [ralNumber, state] of rals.entries()) {
        if (now - state.lastActivityAt > RALRegistry.STATE_TTL_MS) {
          this.clearRAL(state.agentPubkey, state.conversationId, ralNumber);
          cleanedCount++;
          logger.info("[RALRegistry] Cleaned up expired RAL state", {
            agentPubkey: state.agentPubkey.substring(0, 8),
            conversationId: state.conversationId.substring(0, 8),
            ralNumber,
            ageHours: Math.round((now - state.lastActivityAt) / (60 * 60 * 1000)),
          });
        }
      }
      // Clean up empty conversation entries
      if (rals.size === 0) {
        this.states.delete(key);
      }
    }

    if (cleanedCount > 0) {
      logger.info("[RALRegistry] Cleanup complete", {
        cleanedCount,
        remainingConversations: this.states.size,
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
   * Create a new RAL entry for an agent+conversation pair.
   * Returns the RAL number assigned to this execution.
   */
  create(agentPubkey: string, conversationId: string, originalTriggeringEventId?: string): number {
    const id = crypto.randomUUID();
    const now = Date.now();
    const key = this.makeKey(agentPubkey, conversationId);

    // Get next RAL number for this conversation
    const ralNumber = (this.nextRalNumber.get(key) || 0) + 1;
    this.nextRalNumber.set(key, ralNumber);

    const state: RALState = {
      id,
      ralNumber,
      agentPubkey,
      conversationId,
      messages: [],
      uniqueMessagesStartIndex: 0,
      pendingDelegations: [],
      completedDelegations: [],
      queuedInjections: [],
      isStreaming: false,
      createdAt: now,
      lastActivityAt: now,
      originalTriggeringEventId,
    };

    // Get or create the conversation's RAL map
    let rals = this.states.get(key);
    if (!rals) {
      rals = new Map();
      this.states.set(key, rals);
    }
    rals.set(ralNumber, state);

    // Track reverse lookup
    this.ralIdToLocation.set(id, { key, ralNumber });

    trace.getActiveSpan()?.addEvent("ral.created", {
      "ral.id": id,
      "ral.number": ralNumber,
      "agent.pubkey": agentPubkey,
      "conversation.id": conversationId,
    });

    return ralNumber;
  }

  /**
   * Get all active RALs for an agent+conversation
   */
  getActiveRALs(agentPubkey: string, conversationId: string): RALState[] {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (!rals) return [];
    return Array.from(rals.values());
  }

  /**
   * Get summaries of other active RALs (excluding the specified one)
   * Used to inject context about concurrent executions
   */
  getOtherRALSummaries(agentPubkey: string, conversationId: string, excludeRalNumber: number): RALSummary[] {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    return rals
      .filter(r => r.ralNumber !== excludeRalNumber)
      .map(r => ({
        ralNumber: r.ralNumber,
        ralId: r.id,
        isStreaming: r.isStreaming,
        currentTool: r.currentTool,
        // Only include messages unique to this RAL (from triggering event onward)
        uniqueMessages: r.messages.slice(r.uniqueMessagesStartIndex),
        pendingDelegations: r.pendingDelegations.map(d => ({
          recipientSlug: d.recipientSlug,
          prompt: d.prompt.substring(0, 100) + (d.prompt.length > 100 ? "..." : ""),
          eventId: d.eventId,
        })),
        createdAt: r.createdAt,
        hasPendingDelegations: r.pendingDelegations.length > 0,
      }));
  }

  /**
   * Get a specific RAL by number
   */
  getRAL(agentPubkey: string, conversationId: string, ralNumber: number): RALState | undefined {
    const key = this.makeKey(agentPubkey, conversationId);
    return this.states.get(key)?.get(ralNumber);
  }

  /**
   * Get RAL state by RAL ID
   */
  getStateByRalId(ralId: string): RALState | undefined {
    const location = this.ralIdToLocation.get(ralId);
    if (!location) return undefined;
    return this.states.get(location.key)?.get(location.ralNumber);
  }

  /**
   * Get the current (most recent) RAL for an agent+conversation
   * This is for backwards compatibility with code that expects a single RAL
   */
  getState(agentPubkey: string, conversationId: string): RALState | undefined {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (!rals || rals.size === 0) return undefined;

    // Return the RAL with the highest number (most recent)
    let maxRal: RALState | undefined;
    for (const ral of rals.values()) {
      if (!maxRal || ral.ralNumber > maxRal.ralNumber) {
        maxRal = ral;
      }
    }
    return maxRal;
  }

  /**
   * Set whether agent is currently streaming
   */
  setStreaming(agentPubkey: string, conversationId: string, ralNumber: number, isStreaming: boolean): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (ral) {
      ral.isStreaming = isStreaming;
      ral.lastActivityAt = Date.now();
    }
  }

  /**
   * Check if any RAL for this agent+conversation is streaming
   */
  isAnyStreaming(agentPubkey: string, conversationId: string): boolean {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    return rals.some(r => r.isStreaming);
  }

  /**
   * Save/update messages for a specific RAL
   * @param uniqueContentStartsAt - Index where this RAL's unique content starts (typically the triggering event).
   *                                Only needs to be set on first save. Subsequent saves will preserve the original value.
   */
  saveMessages(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    messages: ModelMessage[],
    uniqueContentStartsAt?: number
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] No RAL found to save messages", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return;
    }

    // Only update the start index on first save (when it's still 0 and we have a value)
    if (ral.uniqueMessagesStartIndex === 0 && uniqueContentStartsAt !== undefined) {
      ral.uniqueMessagesStartIndex = uniqueContentStartsAt;
    }

    ral.messages = messages;
    ral.lastActivityAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.messages_saved", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "message.count": messages.length,
    });
  }

  /**
   * Get messages for a specific RAL
   */
  getMessages(agentPubkey: string, conversationId: string, ralNumber: number): ModelMessage[] {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral || ral.messages.length === 0) return [];
    return [...ral.messages];
  }

  /**
   * Check if RAL has saved messages
   */
  hasMessages(agentPubkey: string, conversationId: string, ralNumber: number): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    return !!ral && ral.messages.length > 0;
  }

  /**
   * Save messages and pending delegations for a specific RAL
   */
  saveState(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    messages: ModelMessage[],
    pendingDelegations: PendingDelegation[]
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] No RAL found to save state", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return;
    }

    const key = this.makeKey(agentPubkey, conversationId);
    ral.messages = messages;
    ral.pendingDelegations = pendingDelegations;
    ral.lastActivityAt = Date.now();

    // Register delegation event ID -> RAL mappings
    for (const d of pendingDelegations) {
      this.delegationToRal.set(d.eventId, { key, ralNumber });
    }

    trace.getActiveSpan()?.addEvent("ral.state_saved", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "message.count": messages.length,
      "delegation.pending_count": pendingDelegations.length,
    });
  }

  /**
   * Record a delegation completion (looks up RAL from delegation event ID)
   */
  recordCompletion(completion: CompletedDelegation): RALState | undefined {
    const location = this.delegationToRal.get(completion.eventId);
    if (!location) return undefined;

    const ral = this.states.get(location.key)?.get(location.ralNumber);
    if (!ral) return undefined;

    ral.completedDelegations.push(completion);
    ral.lastActivityAt = Date.now();

    // Remove from pending
    ral.pendingDelegations = ral.pendingDelegations.filter(
      (p) => p.eventId !== completion.eventId
    );

    trace.getActiveSpan()?.addEvent("ral.completion_recorded", {
      "ral.id": ral.id,
      "ral.number": ral.ralNumber,
      "delegation.completed_event_id": completion.eventId,
      "delegation.remaining_pending": ral.pendingDelegations.length,
    });

    return ral;
  }

  /**
   * Inject a system message into a specific RAL
   * Returns true if successful, false if RAL not found
   */
  injectToRAL(
    agentPubkey: string,
    conversationId: string,
    targetRalNumber: number,
    message: string
  ): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, targetRalNumber);
    if (!ral) {
      logger.warn("[RALRegistry] Cannot inject - RAL not found", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        targetRalNumber,
      });
      return false;
    }

    // Enforce queue size limit
    if (ral.queuedInjections.length >= RALRegistry.MAX_QUEUE_SIZE) {
      const dropped = ral.queuedInjections.shift();
      logger.warn("[RALRegistry] Queue full, dropping oldest message", {
        agentPubkey: agentPubkey.substring(0, 8),
        droppedEventId: dropped?.eventId?.substring(0, 8),
      });
    }

    ral.queuedInjections.push({
      role: "system",
      content: message,
      queuedAt: Date.now(),
    });

    trace.getActiveSpan()?.addEvent("ral.message_injected", {
      "ral.number": targetRalNumber,
      "message.length": message.length,
    });

    return true;
  }

  /**
   * Abort a specific RAL
   * Returns { success: true } or { success: false, reason: string }
   */
  abortRAL(
    agentPubkey: string,
    conversationId: string,
    targetRalNumber: number
  ): { success: boolean; reason?: string } {
    const ral = this.getRAL(agentPubkey, conversationId, targetRalNumber);
    if (!ral) {
      return { success: false, reason: "RAL not found" };
    }

    if (ral.pendingDelegations.length > 0) {
      return {
        success: false,
        reason: `RAL has ${ral.pendingDelegations.length} pending delegation(s). Use delegate_followup to communicate with them first.`,
      };
    }

    // Abort any running tool
    const key = this.makeKey(agentPubkey, conversationId);
    const abortKey = this.makeAbortKey(key, targetRalNumber);
    const controller = this.abortControllers.get(abortKey);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(abortKey);
    }

    // Clear the RAL
    this.clearRAL(agentPubkey, conversationId, targetRalNumber);

    trace.getActiveSpan()?.addEvent("ral.aborted", {
      "ral.number": targetRalNumber,
    });

    return { success: true };
  }

  /**
   * Queue a system message for injection into a specific RAL
   */
  queueSystemMessage(agentPubkey: string, conversationId: string, ralNumber: number, message: string): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] Cannot queue system message - no RAL state", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return;
    }

    if (ral.queuedInjections.length >= RALRegistry.MAX_QUEUE_SIZE) {
      const dropped = ral.queuedInjections.shift();
      logger.warn("[RALRegistry] Queue full, dropping oldest message", {
        agentPubkey: agentPubkey.substring(0, 8),
        droppedEventId: dropped?.eventId?.substring(0, 8),
      });
    }

    ral.queuedInjections.push({
      role: "system",
      content: message,
      queuedAt: Date.now(),
    });
  }

  /**
   * Queue an event for injection into a specific RAL
   */
  queueEvent(agentPubkey: string, conversationId: string, ralNumber: number, event: NDKEvent): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] Cannot queue event - no RAL state", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
        eventId: event.id?.substring(0, 8),
      });
      return;
    }

    if (ral.queuedInjections.length >= RALRegistry.MAX_QUEUE_SIZE) {
      const dropped = ral.queuedInjections.shift();
      logger.warn("[RALRegistry] Queue full, dropping oldest event", {
        agentPubkey: agentPubkey.substring(0, 8),
        droppedEventId: dropped?.eventId?.substring(0, 8),
      });
    }

    ral.queuedInjections.push({
      role: "user",
      content: event.content,
      eventId: event.id,
      queuedAt: Date.now(),
    });

    trace.getActiveSpan()?.addEvent("ral.event_queued", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "event.id": event.id || "",
      "queue.size": ral.queuedInjections.length,
    });
  }

  /**
   * Get and persist queued injections for a specific RAL
   */
  getAndPersistInjections(agentPubkey: string, conversationId: string, ralNumber: number): QueuedInjection[] {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return [];

    if (ral.queuedInjections.length === 0) {
      return [];
    }

    const newInjections = [...ral.queuedInjections];
    ral.queuedInjections = [];

    for (const injection of newInjections) {
      ral.messages.push({
        role: injection.role,
        content: injection.content,
      });
    }

    trace.getActiveSpan()?.addEvent("ral.injections_persisted", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "injection.count": newInjections.length,
      "total_messages": ral.messages.length,
    });

    return newInjections;
  }

  /**
   * Check if an event is still queued for injection
   */
  eventStillQueued(agentPubkey: string, conversationId: string, ralNumber: number, eventId: string): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return false;
    return ral.queuedInjections.some(i => i.eventId === eventId);
  }

  /**
   * Swap a queued user event with a system message
   */
  swapQueuedEvent(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    eventId: string,
    systemMessage: string
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return;

    // Find and remove the event
    ral.queuedInjections = ral.queuedInjections.filter(i => i.eventId !== eventId);

    // Add system message instead
    ral.queuedInjections.push({
      role: "system",
      content: systemMessage,
      queuedAt: Date.now(),
    });
  }

  /**
   * Set current tool being executed
   */
  setCurrentTool(agentPubkey: string, conversationId: string, ralNumber: number, toolName: string | undefined): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return;

    ral.currentTool = toolName;
    ral.toolStartedAt = toolName ? Date.now() : undefined;

    if (!toolName) {
      const key = this.makeKey(agentPubkey, conversationId);
      this.abortControllers.delete(this.makeAbortKey(key, ralNumber));
    }
  }

  /**
   * Register an abort controller for a specific RAL
   */
  registerAbortController(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    controller: AbortController
  ): void {
    const key = this.makeKey(agentPubkey, conversationId);
    this.abortControllers.set(this.makeAbortKey(key, ralNumber), controller);
  }

  /**
   * Clear a specific RAL
   */
  clearRAL(agentPubkey: string, conversationId: string, ralNumber: number): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (!rals) return;

    const ral = rals.get(ralNumber);
    if (ral) {
      // Clean up delegation mappings
      for (const d of ral.pendingDelegations) {
        this.delegationToRal.delete(d.eventId);
      }
      for (const d of ral.completedDelegations) {
        this.delegationToRal.delete(d.eventId);
      }
      // Clean up reverse lookup
      this.ralIdToLocation.delete(ral.id);
    }

    rals.delete(ralNumber);
    this.abortControllers.delete(this.makeAbortKey(key, ralNumber));

    // Clean up empty conversation entries
    if (rals.size === 0) {
      this.states.delete(key);
    }

    trace.getActiveSpan()?.addEvent("ral.cleared", {
      "ral.number": ralNumber,
    });
  }

  /**
   * Clear all RALs for an agent+conversation (legacy compatibility)
   */
  clear(agentPubkey: string, conversationId: string): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (rals) {
      for (const ralNumber of rals.keys()) {
        this.clearRAL(agentPubkey, conversationId, ralNumber);
      }
    }

    // Reset the RAL number counter for this conversation
    this.nextRalNumber.delete(key);
  }

  /**
   * Get summary of a specific RAL for context
   */
  getStateSummary(agentPubkey: string, conversationId: string, ralNumber: number): string {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return "No active execution";

    const toolInfo = ral.currentTool
      ? `Running tool: ${ral.currentTool} for ${Date.now() - (ral.toolStartedAt || 0)}ms`
      : "Between tool calls";

    const recentMessages = ral.messages
      .slice(-4)
      .map((m) => `${m.role}: ${String(m.content).substring(0, 80)}...`)
      .join("\n");

    return `${toolInfo}\n\nRecent context:\n${recentMessages}`;
  }

  /**
   * Find the RAL that has a pending delegation
   */
  findStateWaitingForDelegation(delegationEventId: string): RALState | undefined {
    const location = this.delegationToRal.get(delegationEventId);
    if (!location) return undefined;

    const ral = this.states.get(location.key)?.get(location.ralNumber);
    if (!ral) return undefined;

    const hasPending = ral.pendingDelegations.some(
      (d) => d.eventId === delegationEventId
    );
    return hasPending ? ral : undefined;
  }

  /**
   * Clear completed delegations for a specific RAL
   */
  clearCompletedDelegations(agentPubkey: string, conversationId: string, ralNumber: number): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (ral) {
      for (const d of ral.completedDelegations) {
        this.delegationToRal.delete(d.eventId);
      }
      ral.completedDelegations = [];
    }
  }

  /**
   * Get the RAL key for a delegation event ID (for routing completions)
   */
  getRalKeyForDelegation(delegationEventId: string): string | undefined {
    return this.delegationToRal.get(delegationEventId)?.key;
  }

  /**
   * Find a RAL that should be resumed (has completed delegations, no pending ones).
   * Used when a delegation response arrives to continue the delegator's execution.
   */
  findResumableRAL(agentPubkey: string, conversationId: string): RALState | undefined {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    return rals.find(ral =>
      ral.completedDelegations.length > 0 &&
      ral.pendingDelegations.length === 0 &&
      ral.messages.length > 0
    );
  }

  /**
   * Build a message containing delegation results for injection into the RAL.
   */
  buildDelegationResultsMessage(completions: CompletedDelegation[]): string {
    if (completions.length === 0) {
      return "";
    }

    if (completions.length === 1) {
      const c = completions[0];
      const agent = c.recipientSlug || c.recipientPubkey.substring(0, 8);
      return `Delegation to ${agent} completed. Their response:\n\n${c.response}`;
    }

    const parts = completions.map(c => {
      const agent = c.recipientSlug || c.recipientPubkey.substring(0, 8);
      return `## Response from ${agent}:\n${c.response}`;
    });

    return `All ${completions.length} delegations completed. Responses:\n\n${parts.join("\n\n")}`;
  }

  // === RAL Pause/Resume for concurrent execution coordination ===

  /**
   * Pause all other RALs in this conversation so the new RAL can analyze and decide.
   * Returns the number of RALs that were paused.
   */
  pauseOtherRALs(agentPubkey: string, conversationId: string, pausingRalNumber: number): number {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    let pausedCount = 0;
    const skippedSelf: number[] = [];
    const skippedAlreadyPaused: { ralNumber: number; pausedBy: number }[] = [];
    const paused: number[] = [];

    const span = trace.getActiveSpan();

    for (const ral of rals) {
      if (ral.ralNumber === pausingRalNumber) {
        skippedSelf.push(ral.ralNumber);
        continue;
      }
      if (ral.pausedByRalNumber) {
        skippedAlreadyPaused.push({
          ralNumber: ral.ralNumber,
          pausedBy: ral.pausedByRalNumber,
        });
        continue;
      }

      let resolve: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      ral.pausedByRalNumber = pausingRalNumber;
      ral.pausePromise = promise;
      ral.pauseResolver = resolve!;
      pausedCount++;
      paused.push(ral.ralNumber);
    }

    if (span) {
      span.addEvent("ral.others_paused", {
        pausing_ral: pausingRalNumber,
        total_active_rals: rals.length,
        active_ral_numbers: rals.map(r => r.ralNumber).join(","),
        skipped_self: skippedSelf.join(","),
        skipped_already_paused: skippedAlreadyPaused.map(s => `${s.ralNumber}(by:${s.pausedBy})`).join(","),
        paused_rals: paused.join(","),
        paused_count: pausedCount,
      });
    }

    return pausedCount;
  }

  /**
   * Release all RALs that were paused by this RAL.
   * Returns the number of RALs that were released.
   */
  releaseOtherRALs(agentPubkey: string, conversationId: string, releasingRalNumber: number): number {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    let releasedCount = 0;

    for (const ral of rals) {
      if (ral.pausedByRalNumber !== releasingRalNumber) continue;

      // Resolve the promise to unblock the waiting RAL
      ral.pauseResolver?.();
      ral.pausedByRalNumber = undefined;
      ral.pausePromise = undefined;
      ral.pauseResolver = undefined;
      releasedCount++;
    }

    if (releasedCount > 0) {
      trace.getActiveSpan()?.addEvent("ral.others_released", {
        "ral.releasing_number": releasingRalNumber,
        "ral.released_count": releasedCount,
      });
    }

    return releasedCount;
  }

  /**
   * Check if a RAL is paused and return the promise to await if so.
   * Returns undefined if not paused.
   */
  getPausePromise(agentPubkey: string, conversationId: string, ralNumber: number): Promise<void> | undefined {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    return ral?.pausePromise;
  }

  /**
   * Check if a RAL is currently paused.
   */
  isPaused(agentPubkey: string, conversationId: string, ralNumber: number): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    return ral?.pausedByRalNumber !== undefined;
  }

  // === Convenience methods (for backwards compatibility) ===

  /**
   * Check if any RAL is streaming (convenience wrapper)
   */
  isStreaming(agentPubkey: string, conversationId: string): boolean {
    return this.isAnyStreaming(agentPubkey, conversationId);
  }

  /**
   * Get the most recent RAL number for a conversation
   */
  private getCurrentRalNumber(agentPubkey: string, conversationId: string): number | undefined {
    const ral = this.getState(agentPubkey, conversationId);
    return ral?.ralNumber;
  }

  /**
   * Abort current tool on most recent RAL (convenience for tests)
   */
  abortCurrentTool(agentPubkey: string, conversationId: string): void {
    const ralNumber = this.getCurrentRalNumber(agentPubkey, conversationId);
    if (ralNumber !== undefined) {
      const key = this.makeKey(agentPubkey, conversationId);
      const abortKey = this.makeAbortKey(key, ralNumber);
      const controller = this.abortControllers.get(abortKey);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(abortKey);
        trace.getActiveSpan()?.addEvent("ral.tool_aborted", {
          "ral.number": ralNumber,
        });
      }
    }
  }
}
