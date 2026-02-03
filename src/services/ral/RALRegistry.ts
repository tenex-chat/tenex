import { trace } from "@opentelemetry/api";
import { EventEmitter, type DefaultEventMap } from "tseep";
import { getPubkeyService } from "@/services/PubkeyService";
import { INJECTION_ABORT_REASON, llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import { ConversationStore } from "@/conversations/ConversationStore";
import type {
  InjectionResult,
  InjectionRole,
  RALRegistryEntry,
  PendingDelegation,
  CompletedDelegation,
  QueuedInjection,
  DelegationMessage,
} from "./types";

/** Events emitted by RALRegistry */
export type RALRegistryEvents = DefaultEventMap & {
  /** Emitted when any RAL state changes (streaming, tools, creation, cleanup) */
  updated: (...args: [projectId: string, conversationId: string]) => void;
};

/**
 * RAL = Reason-Act Loop
 *
 * Manages state for agent executions within conversations.
 * Each RAL represents one execution cycle where the agent reasons about
 * input and takes actions via tool calls.
 *
 * Simplified execution model: ONE active execution per agent at a time.
 * New messages get injected into the active execution.
 */
export class RALRegistry extends EventEmitter<RALRegistryEvents> {
  private static instance: RALRegistry;

  /**
   * RAL states keyed by "agentPubkey:conversationId", value is Map of ralNumber -> RALRegistryEntry
   * With simplified execution model, only one RAL is active per agent+conversation at a time.
   */
  private states: Map<string, Map<number, RALRegistryEntry>> = new Map();

  /** Track next RAL number for each conversation */
  private nextRalNumber: Map<string, number> = new Map();

  /** Maps delegation event ID -> {key, ralNumber} for O(1) lookup */
  private delegationToRal: Map<string, { key: string; ralNumber: number }> = new Map();

  /** Maps RAL ID -> {key, ralNumber} for O(1) reverse lookup */
  private ralIdToLocation: Map<string, { key: string; ralNumber: number }> = new Map();

  /** Maps followupEventId -> delegationConversationId for resolving followup completion routing */
  private followupToCanonical: Map<string, string> = new Map();

  /** Abort controllers keyed by "key:ralNumber" */
  private abortControllers: Map<string, AbortController> = new Map();

  /** Delegations keyed by "agentPubkey:conversationId" - persists beyond RAL lifetime */
  private conversationDelegations: Map<string, {
    pending: Map<string, PendingDelegation>;
    completed: Map<string, CompletedDelegation>;
  }> = new Map();

  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Maximum age for RAL states before cleanup (default: 24 hours) */
  private static readonly STATE_TTL_MS = 24 * 60 * 60 * 1000;
  /** Cleanup interval (default: 1 hour) */
  private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  /** Maximum queue size for injections (prevents DoS) */
  private static readonly MAX_QUEUE_SIZE = 100;

  private constructor() {
    super();
    this.startCleanupInterval();
  }

  private makeKey(agentPubkey: string, conversationId: string): string {
    return `${agentPubkey}:${conversationId}`;
  }

  private makeAbortKey(key: string, ralNumber: number): string {
    return `${key}:${ralNumber}`;
  }

  /**
   * Emit an 'updated' event for a conversation.
   * Called when streaming state, tool state, or RAL lifecycle changes.
   * @param projectId - The project this RAL belongs to (for multi-project isolation)
   * @param conversationId - The conversation ID
   */
  private emitUpdated(projectId: string, conversationId: string): void {
    this.emit("updated", projectId, conversationId);
  }

  private getOrCreateConversationDelegations(key: string): {
    pending: Map<string, PendingDelegation>;
    completed: Map<string, CompletedDelegation>;
  } {
    let delegations = this.conversationDelegations.get(key);
    if (!delegations) {
      delegations = { pending: new Map(), completed: new Map() };
      this.conversationDelegations.set(key, delegations);
    }
    return delegations;
  }

  /**
   * Get pending delegations for a conversation, optionally filtered by RAL number
   */
  getConversationPendingDelegations(agentPubkey: string, conversationId: string, ralNumber?: number): PendingDelegation[] {
    const key = this.makeKey(agentPubkey, conversationId);
    const delegations = this.conversationDelegations.get(key);
    if (!delegations) return [];
    const pending = Array.from(delegations.pending.values());
    return ralNumber !== undefined ? pending.filter(d => d.ralNumber === ralNumber) : pending;
  }

  /**
   * Atomically merge new pending delegations into the registry.
   * This method handles concurrent delegation calls safely by doing an atomic
   * read-modify-write operation - it reads existing delegations, deduplicates,
   * and writes back in a single operation without a read-then-write pattern
   * that could drop updates.
   *
   * When a delegation with the same delegationConversationId already exists,
   * this method merges fields from the new delegation into the existing one,
   * preserving metadata updates (e.g., followupEventId for followup delegations).
   *
   * @param agentPubkey - The agent's pubkey
   * @param conversationId - The conversation ID
   * @param ralNumber - The RAL number for this execution
   * @param newDelegations - New delegations to merge
   * @returns Object with insert and merge counts for telemetry
   */
  mergePendingDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    newDelegations: PendingDelegation[]
  ): { insertedCount: number; mergedCount: number } {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] No RAL found to merge pending delegations", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return { insertedCount: 0, mergedCount: 0 };
    }

    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.getOrCreateConversationDelegations(key);
    ral.lastActivityAt = Date.now();

    let insertedCount = 0;
    let mergedCount = 0;

    // Atomically add/merge delegations, handling duplicates by merging fields
    for (const d of newDelegations) {
      const existing = convDelegations.pending.get(d.delegationConversationId);

      if (existing) {
        // Merge fields from new delegation into existing entry
        // This preserves metadata updates (e.g., followupEventId) on retried delegations
        const merged: PendingDelegation = {
          ...existing,
          ...d,
          ralNumber, // Always use the current RAL number
        };
        convDelegations.pending.set(d.delegationConversationId, merged);

        // Always refresh delegationToRal mapping (RAL number may have changed)
        this.delegationToRal.set(d.delegationConversationId, { key, ralNumber });

        // For followup delegations, ensure the followup event ID is also mapped
        if (merged.type === "followup" && merged.followupEventId) {
          this.delegationToRal.set(merged.followupEventId, { key, ralNumber });
          // Also maintain reverse lookup for completion routing
          this.followupToCanonical.set(merged.followupEventId, d.delegationConversationId);
        }

        mergedCount++;
      } else {
        // New delegation - insert it
        const delegation = { ...d, ralNumber };
        convDelegations.pending.set(d.delegationConversationId, delegation);

        // Register delegation conversation ID -> RAL mappings (for routing delegation responses)
        this.delegationToRal.set(d.delegationConversationId, { key, ralNumber });

        // For followup delegations, also map the followup event ID
        if (d.type === "followup" && d.followupEventId) {
          this.delegationToRal.set(d.followupEventId, { key, ralNumber });
          // Also maintain reverse lookup for completion routing
          this.followupToCanonical.set(d.followupEventId, d.delegationConversationId);
        }

        // Increment O(1) counter for this RAL
        this.incrementDelegationCounter(agentPubkey, conversationId, ralNumber);

        insertedCount++;
      }
    }

    trace.getActiveSpan()?.addEvent("ral.delegations_merged", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "delegation.inserted_count": insertedCount,
      "delegation.merged_count": mergedCount,
      "delegation.total_pending": convDelegations.pending.size,
    });

    return { insertedCount, mergedCount };
  }

  /**
   * Get completed delegations for a conversation, optionally filtered by RAL number
   */
  getConversationCompletedDelegations(agentPubkey: string, conversationId: string, ralNumber?: number): CompletedDelegation[] {
    const key = this.makeKey(agentPubkey, conversationId);
    const delegations = this.conversationDelegations.get(key);
    if (!delegations) return [];
    const completed = Array.from(delegations.completed.values());
    return ralNumber !== undefined ? completed.filter(d => d.ralNumber === ralNumber) : completed;
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
   * @param projectId - The project this RAL belongs to (required for multi-project isolation)
   */
  create(
    agentPubkey: string,
    conversationId: string,
    projectId: string,
    originalTriggeringEventId?: string,
    traceContext?: { traceId: string; spanId: string }
  ): number {
    const id = crypto.randomUUID();
    const now = Date.now();
    const key = this.makeKey(agentPubkey, conversationId);

    // Get next RAL number for this conversation
    const ralNumber = (this.nextRalNumber.get(key) || 0) + 1;
    this.nextRalNumber.set(key, ralNumber);

    const state: RALRegistryEntry = {
      id,
      ralNumber,
      agentPubkey,
      projectId,
      conversationId,
      queuedInjections: [],
      isStreaming: false,
      activeTools: new Map(),
      createdAt: now,
      lastActivityAt: now,
      originalTriggeringEventId,
      traceId: traceContext?.traceId,
      executionSpanId: traceContext?.spanId,
      accumulatedRuntime: 0,
      lastReportedRuntime: 0,
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
      "conversation.id": shortenConversationId(conversationId),
    });

    // DEBUG: Log RAL creation
    logger.info("[RALRegistry.create] RAL created", {
      ralNumber,
      agentPubkey: agentPubkey.substring(0, 8),
      conversationId: conversationId.substring(0, 8),
      projectId: projectId.substring(0, 20),
      key,
    });

    // Emit update for OperationsStatusService
    this.emitUpdated(projectId, conversationId);

    return ralNumber;
  }

  /**
   * Get all active RALs for an agent+conversation
   */
  getActiveRALs(agentPubkey: string, conversationId: string): RALRegistryEntry[] {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (!rals) return [];
    return Array.from(rals.values());
  }

  /**
   * Get a specific RAL by number
   */
  getRAL(agentPubkey: string, conversationId: string, ralNumber: number): RALRegistryEntry | undefined {
    const key = this.makeKey(agentPubkey, conversationId);
    return this.states.get(key)?.get(ralNumber);
  }

  /**
   * Get RAL state by RAL ID
   */
  getStateByRalId(ralId: string): RALRegistryEntry | undefined {
    const location = this.ralIdToLocation.get(ralId);
    if (!location) return undefined;
    return this.states.get(location.key)?.get(location.ralNumber);
  }

  /**
   * Get the current (most recent) RAL for an agent+conversation
   * This is for backwards compatibility with code that expects a single RAL
   */
  getState(agentPubkey: string, conversationId: string): RALRegistryEntry | undefined {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (!rals || rals.size === 0) return undefined;

    // Return the RAL with the highest number (most recent)
    let maxRal: RALRegistryEntry | undefined;
    for (const ral of rals.values()) {
      if (!maxRal || ral.ralNumber > maxRal.ralNumber) {
        maxRal = ral;
      }
    }
    return maxRal;
  }

  /**
   * Get all RAL entries for a specific conversation (across all agents).
   * Returns an array of entries that can be filtered for streaming/active agents.
   * Used by OperationsStatusService to determine which agents are actively streaming.
   */
  getConversationEntries(conversationId: string): RALRegistryEntry[] {
    const entries: RALRegistryEntry[] = [];
    for (const rals of this.states.values()) {
      for (const ral of rals.values()) {
        if (ral.conversationId === conversationId) {
          entries.push(ral);
        }
      }
    }
    return entries;
  }

  /**
   * Set whether agent is currently streaming
   */
  setStreaming(agentPubkey: string, conversationId: string, ralNumber: number, isStreaming: boolean): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (ral) {
      ral.isStreaming = isStreaming;
      ral.lastActivityAt = Date.now();

      // Derive state from current RAL entry state:
      // - If streaming starts: STREAMING
      // - If streaming stops but any tool is running: ACTING (tool still executing)
      // - If streaming stops and no tools: REASONING (thinking/preparing next action)
      let newState: "STREAMING" | "ACTING" | "REASONING";
      if (isStreaming) {
        newState = "STREAMING";
      } else if (ral.activeTools.size > 0) {
        newState = "ACTING";
      } else {
        newState = "REASONING";
      }

      llmOpsRegistry.updateRALState(agentPubkey, conversationId, newState);

      // Emit update for OperationsStatusService
      this.emitUpdated(ral.projectId, conversationId);
    }
  }

  /**
   * Mark the start of an LLM streaming session.
   * Call this immediately before llmService.stream() to begin timing.
   *
   * @param lastUserMessage - The last user message that triggered this LLM call (for debugging)
   */
  startLLMStream(agentPubkey: string, conversationId: string, ralNumber: number, lastUserMessage?: string): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (ral) {
      const now = Date.now();
      ral.llmStreamStartTime = now;
      ral.lastRuntimeCheckpointAt = now; // Initialize checkpoint to stream start
      ral.lastActivityAt = now;

      // Include the last user message in telemetry for debugging
      // Truncate to 1000 chars to avoid bloating traces
      const truncatedMessage = lastUserMessage
        ? (lastUserMessage.length > 1000 ? lastUserMessage.substring(0, 1000) + "..." : lastUserMessage)
        : undefined;

      trace.getActiveSpan()?.addEvent("ral.llm_stream_started", {
        "ral.number": ralNumber,
        "ral.accumulated_runtime_ms": ral.accumulatedRuntime,
        ...(truncatedMessage && { "ral.last_user_message": truncatedMessage }),
      });
    }
  }

  /**
   * Mark the end of an LLM streaming session and accumulate the runtime.
   * Call this in the finally block after llmService.stream() completes.
   * @returns The total accumulated runtime in milliseconds
   */
  endLLMStream(agentPubkey: string, conversationId: string, ralNumber: number): number {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (ral && ral.llmStreamStartTime !== undefined) {
      const now = Date.now();
      // Calculate TOTAL stream duration from original start (not from checkpoint)
      const streamDuration = now - ral.llmStreamStartTime;
      // Add only the time since last checkpoint (to avoid double-counting what was already consumed)
      const checkpointTime = ral.lastRuntimeCheckpointAt ?? ral.llmStreamStartTime;
      // Guard against clock rollback - keep runtime monotonic
      const unreportedDuration = Math.max(0, now - checkpointTime);
      ral.accumulatedRuntime += unreportedDuration;
      // Clear both stream timing fields
      ral.llmStreamStartTime = undefined;
      ral.lastRuntimeCheckpointAt = undefined;
      ral.lastActivityAt = now;

      trace.getActiveSpan()?.addEvent("ral.llm_stream_ended", {
        "ral.number": ralNumber,
        "ral.stream_duration_ms": streamDuration,
        "ral.accumulated_runtime_ms": ral.accumulatedRuntime,
      });

      return ral.accumulatedRuntime;
    }
    return ral?.accumulatedRuntime ?? 0;
  }

  /**
   * Get the accumulated LLM runtime for a RAL
   */
  getAccumulatedRuntime(agentPubkey: string, conversationId: string, ralNumber: number): number {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    return ral?.accumulatedRuntime ?? 0;
  }

  /**
   * Get the unreported runtime (runtime accumulated since last publish) and mark it as reported.
   * Returns the unreported runtime in milliseconds, then resets the counter.
   * This is used for incremental runtime reporting in agent events.
   *
   * IMPORTANT: This method handles mid-stream runtime calculation. When called during an active
   * LLM stream, it calculates the "live" runtime since the last checkpoint (or stream start),
   * accumulates it, and updates the checkpoint timestamp. The original llmStreamStartTime is
   * preserved so that endLLMStream() can still report correct total stream duration.
   */
  consumeUnreportedRuntime(agentPubkey: string, conversationId: string, ralNumber: number): number {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      // DEBUG: RAL not found
      logger.warn("[RALRegistry.consumeUnreportedRuntime] RAL not found", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return 0;
    }

    const now = Date.now();

    // DEBUG: Log state before calculating
    logger.info("[RALRegistry.consumeUnreportedRuntime] RAL state", {
      agentPubkey: agentPubkey.substring(0, 8),
      ralNumber,
      llmStreamStartTime: ral.llmStreamStartTime,
      lastRuntimeCheckpointAt: ral.lastRuntimeCheckpointAt,
      accumulatedRuntime: ral.accumulatedRuntime,
      lastReportedRuntime: ral.lastReportedRuntime,
    });

    // If there's an active LLM stream, capture the runtime since last checkpoint
    // Use checkpoint if available, otherwise fall back to stream start
    if (ral.llmStreamStartTime !== undefined) {
      const checkpointTime = ral.lastRuntimeCheckpointAt ?? ral.llmStreamStartTime;
      const liveStreamRuntime = now - checkpointTime;
      ral.accumulatedRuntime += liveStreamRuntime;
      // Update checkpoint only - preserve llmStreamStartTime for endLLMStream()
      ral.lastRuntimeCheckpointAt = now;
    }

    const unreported = ral.accumulatedRuntime - ral.lastReportedRuntime;

    // Guard against NaN or negative deltas (defensive programming)
    // Repair lastReportedRuntime to prevent permanent suppression of future runtime
    if (!Number.isFinite(unreported) || unreported < 0) {
      logger.warn("[RALRegistry] Invalid runtime delta", {
        unreported,
        accumulated: ral.accumulatedRuntime,
        lastReported: ral.lastReportedRuntime,
      });
      ral.lastReportedRuntime = ral.accumulatedRuntime;
      return 0;
    }

    ral.lastReportedRuntime = ral.accumulatedRuntime;

    if (unreported > 0) {
      trace.getActiveSpan()?.addEvent("ral.runtime_consumed", {
        "ral.number": ralNumber,
        "ral.unreported_runtime_ms": unreported,
        "ral.accumulated_runtime_ms": ral.accumulatedRuntime,
      });
    }

    return unreported;
  }

  /**
   * Get the unreported runtime without consuming it.
   * Use consumeUnreportedRuntime() when publishing events.
   *
   * NOTE: This also calculates "live" runtime during active streams for accurate preview.
   */
  getUnreportedRuntime(agentPubkey: string, conversationId: string, ralNumber: number): number {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return 0;

    // Calculate current accumulated + live stream time since checkpoint for accurate preview
    let effectiveAccumulated = ral.accumulatedRuntime;
    if (ral.llmStreamStartTime !== undefined) {
      const checkpointTime = ral.lastRuntimeCheckpointAt ?? ral.llmStreamStartTime;
      effectiveAccumulated += Date.now() - checkpointTime;
    }

    return effectiveAccumulated - ral.lastReportedRuntime;
  }

  /**
   * Set pending delegations for a specific RAL (delegation tracking only, not message storage).
   *
   * WARNING: This method replaces ALL pending delegations for the given RAL.
   * For concurrent-safe updates that preserve existing delegations, use mergePendingDelegations().
   *
   * @deprecated Prefer mergePendingDelegations() for concurrent-safe updates.
   * This method exists for backwards compatibility and specific use cases where
   * complete replacement semantics are required.
   */
  setPendingDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    pendingDelegations: PendingDelegation[]
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] No RAL found to set pending delegations", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return;
    }

    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.getOrCreateConversationDelegations(key);
    ral.lastActivityAt = Date.now();

    // Clear existing pending for this RAL, then add new ones
    for (const [id, d] of convDelegations.pending) {
      if (d.ralNumber === ralNumber) {
        convDelegations.pending.delete(id);
        this.delegationToRal.delete(id);
        // Also clean up followup event ID mappings
        if (d.type === "followup" && d.followupEventId) {
          this.delegationToRal.delete(d.followupEventId);
          this.followupToCanonical.delete(d.followupEventId);
        }
      }
    }

    // Add new pending delegations using the shared helper logic
    // Note: We don't use mergePendingDelegations here because we've already cleared
    // existing delegations for this RAL - merge semantics would be redundant
    for (const d of pendingDelegations) {
      // Ensure ralNumber is set
      const delegation = { ...d, ralNumber };
      convDelegations.pending.set(d.delegationConversationId, delegation);

      // Register delegation conversation ID -> RAL mappings (for routing delegation responses)
      this.delegationToRal.set(d.delegationConversationId, { key, ralNumber });

      // For followup delegations, also map the followup event ID
      // This ensures responses e-tagging either the original or followup are routed correctly
      if (d.type === "followup" && d.followupEventId) {
        this.delegationToRal.set(d.followupEventId, { key, ralNumber });
        // Also maintain reverse lookup for completion routing
        this.followupToCanonical.set(d.followupEventId, d.delegationConversationId);
      }
    }

    trace.getActiveSpan()?.addEvent("ral.delegations_set", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "delegation.pending_count": pendingDelegations.length,
    });
  }

  /**
   * Record a delegation completion (looks up RAL from delegation event ID).
   * Builds a transcript from the pending delegation's prompt and the response.
   * For followups, appends both the followup prompt and response to the transcript.
   * Returns location info for the caller to use for resumption.
   *
   * INVARIANT: Completions for killed delegations are rejected at the domain layer.
   * This prevents the race condition where a delegation completes after being killed
   * via the kill tool but before the abort fully propagates.
   *
   * @param completion.fullTranscript - Optional rich transcript to use instead of
   *   constructing a synthetic 2-message transcript. Useful for capturing user
   *   interventions and multi-turn exchanges within a delegation.
   */
  recordCompletion(completion: {
    delegationConversationId: string;
    recipientPubkey: string;
    response: string;
    completedAt: number;
    /** If provided, use this transcript instead of constructing from prompt + response */
    fullTranscript?: DelegationMessage[];
  }): { agentPubkey: string; conversationId: string; ralNumber: number } | undefined {
    const location = this.delegationToRal.get(completion.delegationConversationId);
    if (!location) return undefined;

    const [agentPubkey, conversationId] = location.key.split(":");
    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) return undefined;

    // Resolve followup event ID to canonical delegation conversation ID if needed
    // The pending map is keyed by the original delegationConversationId, not the followupEventId
    const canonicalId = this.followupToCanonical.get(completion.delegationConversationId)
      ?? completion.delegationConversationId;

    const pendingDelegation = convDelegations.pending.get(canonicalId);
    if (!pendingDelegation) {
      logger.warn("[RALRegistry] No pending delegation found for completion", {
        delegationConversationId: completion.delegationConversationId.substring(0, 8),
      });
      return undefined;
    }

    // DOMAIN INVARIANT: Reject completions for killed delegations.
    // This is the authoritative check - no caller can bypass it.
    if (pendingDelegation.killed) {
      trace.getActiveSpan()?.addEvent("ral.completion_rejected_killed", {
        "delegation.conversation_id": shortenConversationId(canonicalId),
        "delegation.killed_at": pendingDelegation.killedAt,
      });
      logger.info("[RALRegistry.recordCompletion] Rejected completion - delegation was killed", {
        delegationConversationId: canonicalId.substring(0, 12),
        killedAt: pendingDelegation.killedAt,
      });
      return undefined;
    }

    // Only record completion if the response is from the delegatee, not the delegator
    // A message from the delegator (e.g., delegate_followup) is not a completion response
    if (completion.recipientPubkey !== pendingDelegation.recipientPubkey) {
      logger.debug("[RALRegistry] Ignoring completion - sender is not the delegatee", {
        delegationConversationId: completion.delegationConversationId.substring(0, 8),
        expectedRecipient: pendingDelegation.recipientPubkey.substring(0, 8),
        actualSender: completion.recipientPubkey.substring(0, 8),
      });
      return undefined;
    }

    // Update RAL activity if it still exists
    const ral = this.states.get(location.key)?.get(location.ralNumber);
    if (ral) {
      ral.lastActivityAt = Date.now();
    }

    // Check if this delegation already has a completed entry (followup case)
    // Use canonical ID for lookups since completed entries are keyed by original delegation ID
    const existingCompletion = convDelegations.completed.get(canonicalId);

    if (existingCompletion) {
      // Append to existing transcript
      if (completion.fullTranscript) {
        // Use provided full transcript - replace entire transcript
        existingCompletion.transcript = completion.fullTranscript;
      } else {
        // Fall back to appending the followup prompt and response
        existingCompletion.transcript.push({
          senderPubkey: pendingDelegation.senderPubkey,
          recipientPubkey: pendingDelegation.recipientPubkey,
          content: pendingDelegation.prompt,
          timestamp: completion.completedAt - 1, // Just before the response
        });
        existingCompletion.transcript.push({
          senderPubkey: completion.recipientPubkey,
          recipientPubkey: pendingDelegation.senderPubkey,
          content: completion.response,
          timestamp: completion.completedAt,
        });
      }

      // Update ralNumber to the followup's RAL so findResumableRAL finds the correct RAL
      existingCompletion.ralNumber = pendingDelegation.ralNumber;

      trace.getActiveSpan()?.addEvent("ral.followup_response_appended", {
        "ral.id": ral?.id,
        "ral.number": location.ralNumber,
        "delegation.completed_conversation_id": shortenConversationId(completion.delegationConversationId),
        "delegation.transcript_length": existingCompletion.transcript.length,
      });
    } else {
      // Create new completed delegation with transcript
      // Use provided fullTranscript if available, otherwise construct synthetic 2-message transcript
      const transcript: DelegationMessage[] = completion.fullTranscript ?? [
        {
          senderPubkey: pendingDelegation.senderPubkey,
          recipientPubkey: pendingDelegation.recipientPubkey,
          content: pendingDelegation.prompt,
          timestamp: completion.completedAt - 1,
        },
        {
          senderPubkey: completion.recipientPubkey,
          recipientPubkey: pendingDelegation.senderPubkey,
          content: completion.response,
          timestamp: completion.completedAt,
        },
      ];

      convDelegations.completed.set(canonicalId, {
        delegationConversationId: canonicalId,
        recipientPubkey: completion.recipientPubkey,
        senderPubkey: pendingDelegation.senderPubkey,
        ralNumber: pendingDelegation.ralNumber,
        transcript,
        completedAt: completion.completedAt,
        status: "completed",
      });

      const remainingPending = this.getConversationPendingDelegations(agentPubkey, conversationId, location.ralNumber).length - 1;
      trace.getActiveSpan()?.addEvent("ral.completion_recorded", {
        "ral.id": ral?.id,
        "ral.number": location.ralNumber,
        "delegation.completed_conversation_id": shortenConversationId(completion.delegationConversationId),
        "delegation.remaining_pending": remainingPending,
      });
    }

    // Remove from pending using canonical ID
    convDelegations.pending.delete(canonicalId);

    // Decrement O(1) counter for this RAL
    this.decrementDelegationCounter(agentPubkey, conversationId, location.ralNumber);

    return { agentPubkey, conversationId, ralNumber: location.ralNumber };
  }

  /**
   * Queue a message for injection and abort streaming runs if needed.
   */
  injectMessage(params: {
    agentPubkey: string;
    conversationId: string;
    message: string;
    role?: InjectionRole;
  }): InjectionResult {
    const {
      agentPubkey,
      conversationId,
      message,
      role = "user",
    } = params;
    const activeRal = this.getState(agentPubkey, conversationId);

    if (!activeRal) {
      return {
        queued: false,
        aborted: false,
      };
    }

    this.queueMessage(agentPubkey, conversationId, activeRal.ralNumber, role, message);

    const messageLength = message.length;
    let aborted = false;

    if (activeRal.isStreaming) {
      aborted = llmOpsRegistry.stopByAgentAndConversation(
        agentPubkey,
        conversationId,
        INJECTION_ABORT_REASON
      );

      trace.getActiveSpan()?.addEvent("ral.injection_streaming", {
        "ral.id": activeRal.id,
        "ral.number": activeRal.ralNumber,
        "injection.length": messageLength,
        aborted,
      });

      if (aborted) {
        logger.info("[RALRegistry] Aborted streaming execution for injection", {
          agentPubkey: agentPubkey.substring(0, 8),
          conversationId: conversationId.substring(0, 8),
          ralNumber: activeRal.ralNumber,
          injectionLength: messageLength,
        });
      }
    }

    trace.getActiveSpan()?.addEvent("ral.injection_queued", {
      "ral.id": activeRal.id,
      "ral.number": activeRal.ralNumber,
      "injection.role": role,
      "injection.length": messageLength,
      "ral.is_streaming": activeRal.isStreaming,
    });

    return {
      activeRal,
      queued: true,
      aborted,
    };
  }

  /**
   * Queue a system message for injection into a specific RAL
   */
  queueSystemMessage(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    message: string
  ): void {
    this.queueMessage(agentPubkey, conversationId, ralNumber, "system", message);
  }

  /**
   * Queue a user message for injection into a specific RAL
   */
  queueUserMessage(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    message: string,
    options?: { ephemeral?: boolean; senderPubkey?: string; eventId?: string }
  ): void {
    this.queueMessage(agentPubkey, conversationId, ralNumber, "user", message, options);
  }

  /**
   * Queue a message with specified role for injection into a specific RAL
   */
  private queueMessage(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    role: "system" | "user",
    message: string,
    options?: { ephemeral?: boolean; senderPubkey?: string; eventId?: string }
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] Cannot queue message - no RAL state", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
        role,
      });
      return;
    }

    if (ral.queuedInjections.length >= RALRegistry.MAX_QUEUE_SIZE) {
      ral.queuedInjections.shift();
      logger.warn("[RALRegistry] Queue full, dropping oldest message", {
        agentPubkey: agentPubkey.substring(0, 8),
      });
    }

    ral.queuedInjections.push({
      role,
      content: message,
      queuedAt: Date.now(),
      ephemeral: options?.ephemeral,
      senderPubkey: options?.senderPubkey,
      eventId: options?.eventId,
    });

    // Add telemetry for ephemeral injection queuing (useful for debugging supervision re-engagement)
    if (options?.ephemeral) {
      trace.getActiveSpan()?.addEvent("ral.ephemeral_correction_queued", {
        "ral.number": ralNumber,
        "message.length": message.length,
        "message.role": role,
      });
    }
  }

  /**
   * Get and consume queued injections for a specific RAL
   * Injections are persisted to ConversationStore by the caller
   */
  getAndConsumeInjections(agentPubkey: string, conversationId: string, ralNumber: number): QueuedInjection[] {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return [];

    if (ral.queuedInjections.length === 0) {
      return [];
    }

    const injections = [...ral.queuedInjections];
    ral.queuedInjections = [];

    trace.getActiveSpan()?.addEvent("ral.injections_consumed", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "injection.count": injections.length,
    });

    return injections;
  }

  /**
   * Track a tool as active or completed by its toolCallId.
   * Supports concurrent tool execution by tracking each tool independently.
   *
   * @param toolCallId - Unique identifier for this tool invocation
   * @param isActive - true when tool starts, false when tool completes
   * @param toolName - Optional tool name for logging/debugging
   */
  setToolActive(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    toolCallId: string,
    isActive: boolean,
    toolName?: string
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return;

    if (isActive) {
      // Store toolCallId -> tool info mapping (name + startedAt)
      const now = Date.now();
      ral.activeTools.set(toolCallId, { name: toolName ?? "unknown", startedAt: now });
      ral.toolStartedAt = now;
      // Maintain backward compatibility - set currentTool to most recent tool name
      ral.currentTool = toolName;
    } else {
      ral.activeTools.delete(toolCallId);
      // Update currentTool to another active tool if any remain, otherwise clear
      if (ral.activeTools.size === 0) {
        ral.currentTool = undefined;
        ral.toolStartedAt = undefined;
      } else {
        // Set currentTool to one of the remaining active tools, including its start time
        // Safe to use ! assertion: we're in the else branch where activeTools.size > 0
        const remainingToolInfo = ral.activeTools.values().next().value;
        if (remainingToolInfo) {
          ral.currentTool = remainingToolInfo.name;
          ral.toolStartedAt = remainingToolInfo.startedAt;
        } else {
          ral.currentTool = undefined;
          ral.toolStartedAt = undefined;
        }
      }
    }

    ral.lastActivityAt = Date.now();

    // Derive state from activeTools:
    // - If any tools are active: ACTING
    // - If no tools but streaming: STREAMING
    // - If no tools and not streaming: REASONING
    let newState: "ACTING" | "STREAMING" | "REASONING";
    if (ral.activeTools.size > 0) {
      newState = "ACTING";
    } else if (ral.isStreaming) {
      newState = "STREAMING";
    } else {
      newState = "REASONING";
    }

    llmOpsRegistry.updateRALState(agentPubkey, conversationId, newState);

    // Emit update for OperationsStatusService
    this.emitUpdated(ral.projectId, conversationId);

    trace.getActiveSpan()?.addEvent(isActive ? "ral.tool_started" : "ral.tool_completed", {
      "ral.number": ralNumber,
      "tool.call_id": toolCallId,
      "tool.name": toolName,
      "ral.active_tools_count": ral.activeTools.size,
    });
  }

  /**
   * Clear a tool from the active set as a fallback.
   * Used by MessageSyncer when a tool result is observed without a prior tool-did-execute event.
   *
   * @param toolCallId - The tool call ID to clear
   * @returns true if the tool was found and removed, false otherwise
   */
  clearToolFallback(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    toolCallId: string
  ): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return false;

    if (!ral.activeTools.has(toolCallId)) {
      return false; // Tool wasn't in active map
    }

    ral.activeTools.delete(toolCallId);
    ral.lastActivityAt = Date.now();

    // Update currentTool to another active tool if any remain, otherwise clear
    if (ral.activeTools.size === 0) {
      ral.currentTool = undefined;
      ral.toolStartedAt = undefined;
    } else {
      // Set currentTool to one of the remaining active tools, including its start time
      const remainingToolInfo = ral.activeTools.values().next().value;
      if (remainingToolInfo) {
        ral.currentTool = remainingToolInfo.name;
        ral.toolStartedAt = remainingToolInfo.startedAt;
      } else {
        ral.currentTool = undefined;
        ral.toolStartedAt = undefined;
      }
    }

    // Update state
    let newState: "ACTING" | "STREAMING" | "REASONING";
    if (ral.activeTools.size > 0) {
      newState = "ACTING";
    } else if (ral.isStreaming) {
      newState = "STREAMING";
    } else {
      newState = "REASONING";
    }

    llmOpsRegistry.updateRALState(agentPubkey, conversationId, newState);

    // Emit update for OperationsStatusService
    this.emitUpdated(ral.projectId, conversationId);

    trace.getActiveSpan()?.addEvent("ral.tool_cleared_fallback", {
      "ral.number": ralNumber,
      "tool.call_id": toolCallId,
      "ral.active_tools_count": ral.activeTools.size,
    });

    return true;
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
   * Clear a specific RAL.
   * NOTE: Delegations persist in conversation storage - only clears RAL state.
   * The delegationToRal routing map stays intact for followup routing.
   */
  clearRAL(agentPubkey: string, conversationId: string, ralNumber: number): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (!rals) return;

    const ral = rals.get(ralNumber);
    // Capture projectId before deletion for emitUpdated
    const projectId = ral?.projectId;

    if (ral) {
      // Clean up reverse lookup
      this.ralIdToLocation.delete(ral.id);
    }

    rals.delete(ralNumber);
    const abortKey = this.makeAbortKey(key, ralNumber);
    this.abortControllers.delete(abortKey);

    // Clean up empty conversation entries
    if (rals.size === 0) {
      this.states.delete(key);
    }

    trace.getActiveSpan()?.addEvent("ral.cleared", {
      "ral.number": ralNumber,
    });

    // Emit update for OperationsStatusService (only if we had a valid projectId)
    if (projectId) {
      this.emitUpdated(projectId, conversationId);
    }
  }

  /**
   * Clear all RALs for an agent+conversation.
   * Also cleans up conversation-level delegation storage.
   */
  clear(agentPubkey: string, conversationId: string): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (rals) {
      for (const ralNumber of rals.keys()) {
        this.clearRAL(agentPubkey, conversationId, ralNumber);
      }
    }

    // Clean up conversation-level delegation storage and routing
    const convDelegations = this.conversationDelegations.get(key);
    if (convDelegations) {
      for (const [id, d] of convDelegations.pending) {
        this.delegationToRal.delete(id);
        // Also clean up followup event ID mappings
        if (d.type === "followup" && d.followupEventId) {
          this.delegationToRal.delete(d.followupEventId);
          this.followupToCanonical.delete(d.followupEventId);
        }
      }
      for (const id of convDelegations.completed.keys()) {
        this.delegationToRal.delete(id);
      }
      this.conversationDelegations.delete(key);
    }

    // Reset the RAL number counter for this conversation
    this.nextRalNumber.delete(key);
  }

  /**
   * Find delegation in conversation storage (doesn't require RAL to exist).
   * Used by delegate_followup to look up delegations even after RAL is cleared.
   * Handles both original delegation IDs and followup event IDs through the reverse lookup.
   */
  findDelegation(delegationEventId: string): {
    pending?: PendingDelegation;
    completed?: CompletedDelegation;
    agentPubkey: string;
    conversationId: string;
    ralNumber: number;
  } | undefined {
    const location = this.delegationToRal.get(delegationEventId);
    if (!location) return undefined;

    const [agentPubkey, conversationId] = location.key.split(":");
    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) return undefined;

    // Resolve followup event ID to canonical delegation conversation ID if needed
    // The pending/completed maps are keyed by the original delegationConversationId
    const canonicalId = this.followupToCanonical.get(delegationEventId) ?? delegationEventId;

    return {
      pending: convDelegations.pending.get(canonicalId),
      completed: convDelegations.completed.get(canonicalId),
      agentPubkey,
      conversationId,
      ralNumber: location.ralNumber,
    };
  }

  /**
   * Find the RAL that has a pending delegation (for routing responses)
   * Handles both original delegation IDs and followup event IDs through the reverse lookup.
   */
  findStateWaitingForDelegation(delegationEventId: string): RALRegistryEntry | undefined {
    const location = this.delegationToRal.get(delegationEventId);
    if (!location) return undefined;

    const ral = this.states.get(location.key)?.get(location.ralNumber);
    if (!ral) return undefined;

    // Resolve followup event ID to canonical delegation conversation ID if needed
    const canonicalId = this.followupToCanonical.get(delegationEventId) ?? delegationEventId;

    // Check if delegation exists in conversation storage
    const convDelegations = this.conversationDelegations.get(location.key);
    const hasPending = convDelegations?.pending.has(canonicalId) ?? false;
    return hasPending ? ral : undefined;
  }

  /**
   * Clear completed delegations for a specific RAL
   */
  clearCompletedDelegations(agentPubkey: string, conversationId: string, ralNumber: number): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.conversationDelegations.get(key);
    if (convDelegations) {
      for (const [id, d] of convDelegations.completed) {
        if (d.ralNumber === ralNumber) {
          this.delegationToRal.delete(id);
          convDelegations.completed.delete(id);
        }
      }
    }
  }

  /**
   * Get the RAL key for a delegation event ID (for routing completions)
   */
  getRalKeyForDelegation(delegationEventId: string): string | undefined {
    return this.delegationToRal.get(delegationEventId)?.key;
  }

  /**
   * Find a RAL that should be resumed (has completed delegations).
   * Used when a delegation response arrives to continue the delegator's execution.
   * The RAL is resumable regardless of pending delegation count - the agent
   * decides what to do (wait, acknowledge, follow-up, etc.)
   */
  findResumableRAL(agentPubkey: string, conversationId: string): RALRegistryEntry | undefined {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    return rals.find(ral => {
      const completed = this.getConversationCompletedDelegations(agentPubkey, conversationId, ral.ralNumber);
      return completed.length > 0;
    });
  }

  /**
   * Find a RAL that has queued injections ready to process.
   */
  findRALWithInjections(agentPubkey: string, conversationId: string): RALRegistryEntry | undefined {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    return rals.find(ral => ral.queuedInjections.length > 0);
  }

  /**
   * Build a message containing delegation results for injection into the RAL.
   * Shows complete conversation transcript for each delegation.
   * Uses shortened delegation IDs (PREFIX_LENGTH chars) for display; agents can use
   * these prefixes directly with delegate_followup which will resolve them.
   * Format: [@sender -> @recipient]: message content
   */
  /**
   * Helper to format transcript with error handling for name resolution.
   */
  private async formatTranscript(transcript: DelegationMessage[]): Promise<string[]> {
    const pubkeyService = getPubkeyService();
    const lines: string[] = [];

    for (const msg of transcript) {
      try {
        const senderName = await pubkeyService.getName(msg.senderPubkey);
        const recipientName = await pubkeyService.getName(msg.recipientPubkey);
        lines.push(`[@${senderName} -> @${recipientName}]: ${msg.content}`);
      } catch (error) {
        // Fallback to shortened pubkeys on error
        const senderFallback = msg.senderPubkey.substring(0, 12);
        const recipientFallback = msg.recipientPubkey.substring(0, 12);
        lines.push(`[@${senderFallback} -> @${recipientFallback}]: ${msg.content}`);
      }
    }

    return lines;
  }

  /**
   * Helper to render a list of pending delegations with error handling.
   */
  private async renderPendingList(pending: PendingDelegation[]): Promise<string[]> {
    if (pending.length === 0) {
      return [];
    }

    const pubkeyService = getPubkeyService();
    const lines: string[] = [];

    lines.push("## Still Pending");
    for (const p of pending) {
      try {
        const recipientName = await pubkeyService.getName(p.recipientPubkey);
        lines.push(`- @${recipientName} (${p.delegationConversationId.substring(0, PREFIX_LENGTH)})`);
      } catch (error) {
        const fallbackName = p.recipientPubkey.substring(0, 12);
        lines.push(`- @${fallbackName} (${p.delegationConversationId.substring(0, PREFIX_LENGTH)})`);
      }
    }
    lines.push("");

    return lines;
  }

  /**
   * Helper to render delegation header (agent name + ID) with error handling.
   */
  private async renderDelegationHeader(
    recipientPubkey: string,
    conversationId: string,
    statusText: string
  ): Promise<string[]> {
    const pubkeyService = getPubkeyService();
    const lines: string[] = [];

    try {
      const recipientName = await pubkeyService.getName(recipientPubkey);
      lines.push(`**@${recipientName} ${statusText}**`);
    } catch (error) {
      const fallbackName = recipientPubkey.substring(0, 12);
      lines.push(`**@${fallbackName} ${statusText}**`);
    }

    lines.push("");
    lines.push(`## Delegation ID: ${conversationId.substring(0, PREFIX_LENGTH)}`);

    return lines;
  }

  /**
   * Build a message for completed delegations.
   * Shows the agent name, conversation ID, and full transcript.
   */
  async buildDelegationResultsMessage(
    completions: CompletedDelegation[],
    pending: PendingDelegation[] = []
  ): Promise<string> {
    if (completions.length === 0) {
      return "";
    }

    const lines: string[] = [];

    lines.push("# DELEGATION COMPLETED");
    lines.push("");

    for (const c of completions) {
      lines.push(...await this.renderDelegationHeader(
        c.recipientPubkey,
        c.delegationConversationId,
        "has finished and returned their final response."
      ));
      lines.push("");
      lines.push("### Transcript:");
      lines.push(...await this.formatTranscript(c.transcript));
      lines.push("");
    }

    // Show pending delegations if any remain
    if (pending.length > 0) {
      lines.push(...await this.renderPendingList(pending));
    }

    return lines.join("\n");
  }

  /**
   * Build a message for aborted delegations.
   * Shows the agent name, conversation ID, abort details, and partial transcript.
   * Format matches buildDelegationResultsMessage for consistency.
   */
  async buildDelegationAbortMessage(
    abortedDelegations: CompletedDelegation[],
    pending: PendingDelegation[] = []
  ): Promise<string> {
    if (abortedDelegations.length === 0) {
      return "";
    }

    const lines: string[] = [];

    // Header indicating abort event
    lines.push("# DELEGATION ABORTED");
    lines.push("");

    // Format each aborted delegation
    for (const c of abortedDelegations) {
      if (c.status !== "aborted") continue; // Type guard for discriminated union

      lines.push(...await this.renderDelegationHeader(
        c.recipientPubkey,
        c.delegationConversationId,
        "was aborted and did not complete their task."
      ));

      // Add abort-specific metadata with error handling for timestamp
      try {
        lines.push(`**Aborted at:** ${new Date(c.completedAt).toISOString()}`);
      } catch {
        lines.push(`**Aborted at:** (invalid timestamp)`);
      }
      lines.push(`**Reason:** ${c.abortReason}`);
      lines.push("");

      // Show partial transcript if available
      if (c.transcript && c.transcript.length > 0) {
        lines.push("### Partial Progress:");
        lines.push(...await this.formatTranscript(c.transcript));
      } else {
        lines.push("### Partial Progress:");
        lines.push("(No messages exchanged before abort)");
      }
      lines.push("");
    }

    // Show remaining pending delegations if any
    if (pending.length > 0) {
      lines.push(...await this.renderPendingList(pending));
    }

    return lines.join("\n");
  }

  /**
   * Determine if a new message should wake up an execution.
   *
   * This is the KEY decision point in the simplified model:
   * - If agent is actively streaming: Don't wake up, message is injected
   * - If agent is waiting on delegations: Wake up to process
   * - If no RAL exists: Wake up (start new execution)
   *
   * @returns true if execution should be started/resumed, false if injection is sufficient
   */
  shouldWakeUpExecution(agentPubkey: string, conversationId: string): boolean {
    const ral = this.getState(agentPubkey, conversationId);

    // No RAL = start new execution
    if (!ral) return true;

    // If currently streaming (actively processing), don't wake up
    // The prepareStep callback will pick up the injected message
    if (ral.isStreaming) return false;

    // If there are completed delegations waiting, wake up
    const completed = this.getConversationCompletedDelegations(
      agentPubkey, conversationId, ral.ralNumber
    );
    if (completed.length > 0) return true;

    // If there are pending delegations, we're waiting - wake up to process new message
    const pending = this.getConversationPendingDelegations(
      agentPubkey, conversationId, ral.ralNumber
    );
    if (pending.length > 0) return true;

    // RAL exists but not streaming and no delegations - it's finished
    // This shouldn't happen often (RAL should be cleared), but wake up to start fresh
    return true;
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

  /**
   * Abort all running RALs for an agent in a conversation.
   * This is used when a stop signal is received to immediately terminate all executions.
   */
  abortAllForAgent(agentPubkey: string, conversationId: string): number {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (!rals) return 0;

    let abortedCount = 0;

    for (const [ralNumber] of rals) {
      const abortKey = this.makeAbortKey(key, ralNumber);
      const controller = this.abortControllers.get(abortKey);
      if (controller && !controller.signal.aborted) {
        controller.abort();
        abortedCount++;
        trace.getActiveSpan()?.addEvent("ral.aborted_by_stop_signal", {
          "ral.number": ralNumber,
          "agent.pubkey": agentPubkey.substring(0, 8),
          "conversation.id": shortenConversationId(conversationId),
        });
      }
    }

    // Clear all state for this agent+conversation
    this.clear(agentPubkey, conversationId);

    return abortedCount;
  }

  /**
   * Abort an agent in a conversation with cascading support.
   * If the conversation has nested delegations (found via delegation chain),
   * this will recursively abort all descendant agents in their respective conversations.
   *
   * @param agentPubkey - The agent's pubkey
   * @param conversationId - The conversation ID
   * @param projectId - The project ID (for cooldown isolation)
   * @param reason - Optional reason for the abort
   * @param cooldownRegistry - Optional cooldown registry to track aborted tuples
   * @returns An object with abortedCount and descendantConversations array
   */
  async abortWithCascade(
    agentPubkey: string,
    conversationId: string,
    projectId: string,
    reason?: string,
    cooldownRegistry?: { add: (projectId: string, convId: string, agentPubkey: string, reason?: string) => void }
  ): Promise<{ abortedCount: number; descendantConversations: Array<{ conversationId: string; agentPubkey: string }> }> {
    const abortedTuples: Array<{ conversationId: string; agentPubkey: string }> = [];

    // CRITICAL: Capture pending delegations AND conversation delegations BEFORE aborting/clearing
    // The abort operation will clear conversation delegations, so we must snapshot them first
    const pendingDelegations = this.getConversationPendingDelegations(agentPubkey, conversationId);
    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.conversationDelegations.get(key);

    // RACE CONDITION FIX: Mark all pending delegations as killed BEFORE aborting.
    // This prevents the race where a delegation completes between the time we abort
    // and the time we process the cascade. The killed flag ensures that any
    // completion events arriving for these delegations will be ignored.
    const killedDelegationCount = this.markAllDelegationsKilled(agentPubkey, conversationId);
    if (killedDelegationCount > 0) {
      trace.getActiveSpan()?.addEvent("ral.delegations_marked_killed_before_abort", {
        "cascade.agent_pubkey": agentPubkey.substring(0, 12),
        "cascade.conversation_id": shortenConversationId(conversationId),
        "cascade.killed_delegation_count": killedDelegationCount,
      });
    }

    // Abort the target agent
    const directAbortCount = this.abortAllForAgent(agentPubkey, conversationId);
    if (directAbortCount > 0) {
      abortedTuples.push({ conversationId, agentPubkey });

      // Add to cooldown registry if provided
      if (cooldownRegistry) {
        cooldownRegistry.add(projectId, conversationId, agentPubkey, reason);
      }

      // Persist abort message in conversation store
      const conversation = ConversationStore.get(conversationId);
      if (conversation) {
        const abortMessage = `This conversation was aborted at ${new Date().toISOString()}. Reason: ${reason ?? "manual abort"}`;
        conversation.addMessage({
          pubkey: "system",
          content: abortMessage,
          messageType: "text",
          timestamp: Math.floor(Date.now() / 1000),
        });
        await conversation.save();
      }
    }

    trace.getActiveSpan()?.addEvent("ral.cascade_abort_started", {
      "cascade.root_conversation_id": shortenConversationId(conversationId),
      "cascade.root_agent_pubkey": agentPubkey.substring(0, 12),
      "cascade.pending_delegations": pendingDelegations.length,
      "cascade.reason": reason ?? "unknown",
    });

    // Recursively abort each pending delegation
    for (const delegation of pendingDelegations) {
      const descendantConvId = delegation.delegationConversationId;
      const descendantAgentPubkey = delegation.recipientPubkey;

      // Get the projectId for the descendant conversation
      const descendantConversation = ConversationStore.get(descendantConvId);
      const descendantProjectId = descendantConversation?.getProjectId() ?? projectId;

      logger.info("[RALRegistry] Cascading abort to nested delegation", {
        parentConversation: shortenConversationId(conversationId),
        parentAgent: agentPubkey.substring(0, 12),
        childConversation: descendantConvId.substring(0, 12),
        childAgent: descendantAgentPubkey.substring(0, 12),
        projectId: descendantProjectId?.substring(0, 12),
      });

      // Recursively abort the descendant
      const descendantResult = await this.abortWithCascade(
        descendantAgentPubkey,
        descendantConvId,
        descendantProjectId,
        `cascaded from ${shortenConversationId(conversationId)}`,
        cooldownRegistry
      );

      // Collect all aborted tuples from descendants
      abortedTuples.push(...descendantResult.descendantConversations);

      // Mark this delegation as aborted by moving it from pending to completed with abort status
      // Use the captured convDelegations from before the abort
      if (convDelegations) {
        // Remove from pending
        const pendingDelegation = convDelegations.pending.get(descendantConvId);
        if (pendingDelegation) {
          convDelegations.pending.delete(descendantConvId);

          // Load partial transcript from the aborted conversation
          const abortedConv = ConversationStore.get(descendantConvId);
          const partialTranscript: DelegationMessage[] = [];
          if (abortedConv) {
            const messages = abortedConv.getAllMessages();
            for (const msg of messages) {
              if (msg.messageType === "text" && msg.targetedPubkeys && msg.targetedPubkeys.length > 0) {
                partialTranscript.push({
                  senderPubkey: msg.pubkey,
                  recipientPubkey: msg.targetedPubkeys[0],
                  content: msg.content,
                  timestamp: msg.timestamp ?? Date.now(),
                });
              }
            }
          }

          // Add to completed with "aborted" status
          convDelegations.completed.set(descendantConvId, {
            delegationConversationId: descendantConvId,
            recipientPubkey: descendantAgentPubkey,
            senderPubkey: pendingDelegation.senderPubkey,
            ralNumber: pendingDelegation.ralNumber,
            transcript: partialTranscript,
            completedAt: Date.now(),
            status: "aborted",
            abortReason: `cascaded from ${shortenConversationId(conversationId)}`,
          });

          trace.getActiveSpan()?.addEvent("ral.delegation_marked_aborted", {
            "delegation.conversation_id": shortenConversationId(descendantConvId),
            "delegation.transcript_length": partialTranscript.length,
          });
        }
      }
    }

    // Re-insert the modified convDelegations back into the Map so it's queryable later
    // This is critical because abortAllForAgent() deleted the Map entry, but we've
    // now added aborted completions to the captured reference
    if (convDelegations && (convDelegations.pending.size > 0 || convDelegations.completed.size > 0)) {
      this.conversationDelegations.set(key, convDelegations);
    }

    trace.getActiveSpan()?.addEvent("ral.cascade_abort_completed", {
      "cascade.root_conversation_id": shortenConversationId(conversationId),
      "cascade.root_agent_pubkey": agentPubkey.substring(0, 12),
      "cascade.total_aborted": abortedTuples.length,
    });

    return {
      abortedCount: directAbortCount,
      descendantConversations: abortedTuples,
    };
  }

  /**
   * Clear all state (for testing)
   */
  clearAll(): void {
    this.states.clear();
    this.nextRalNumber.clear();
    this.delegationToRal.clear();
    this.ralIdToLocation.clear();
    this.abortControllers.clear();
    this.conversationDelegations.clear();
    this.followupToCanonical.clear();
  }

  // ============================================================================
  // Killed Delegation Methods (Race Condition Prevention)
  // ============================================================================

  /**
   * Mark a pending delegation as killed.
   * This prevents the race condition where a delegation completes after being
   * killed but before the abort fully propagates. The killed flag ensures that
   * completion events for killed delegations are ignored.
   *
   * @param delegationConversationId - The delegation conversation ID to mark as killed
   * @returns true if the delegation was found and marked, false otherwise
   */
  markDelegationKilled(delegationConversationId: string): boolean {
    // Look up the delegation's location
    const location = this.delegationToRal.get(delegationConversationId);
    if (!location) {
      logger.debug("[RALRegistry.markDelegationKilled] No delegation found for ID", {
        delegationConversationId: delegationConversationId.substring(0, 12),
      });
      return false;
    }

    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) {
      return false;
    }

    // Resolve followup event ID to canonical delegation conversation ID if needed
    const canonicalId = this.followupToCanonical.get(delegationConversationId)
      ?? delegationConversationId;

    const pendingDelegation = convDelegations.pending.get(canonicalId);
    if (!pendingDelegation) {
      logger.debug("[RALRegistry.markDelegationKilled] No pending delegation found", {
        delegationConversationId: canonicalId.substring(0, 12),
      });
      return false;
    }

    // Idempotent: preserve original kill time for audit trail
    if (pendingDelegation.killed) {
      logger.debug("[RALRegistry.markDelegationKilled] Delegation already killed", {
        delegationConversationId: canonicalId.substring(0, 12),
        killedAt: pendingDelegation.killedAt,
      });
      return true; // Already killed, but return true to indicate it's in killed state
    }

    // Mark the delegation as killed
    pendingDelegation.killed = true;
    pendingDelegation.killedAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.delegation_marked_killed", {
      "delegation.conversation_id": shortenConversationId(canonicalId),
      "delegation.recipient_pubkey": pendingDelegation.recipientPubkey.substring(0, 12),
    });

    logger.info("[RALRegistry.markDelegationKilled] Delegation marked as killed", {
      delegationConversationId: canonicalId.substring(0, 12),
      recipientPubkey: pendingDelegation.recipientPubkey.substring(0, 12),
    });

    return true;
  }

  /**
   * Check if a delegation has been marked as killed.
   * Used by completion handlers to skip processing killed delegations.
   *
   * @param delegationConversationId - The delegation conversation ID to check
   * @returns true if the delegation is killed, false if not found or not killed
   */
  isDelegationKilled(delegationConversationId: string): boolean {
    const location = this.delegationToRal.get(delegationConversationId);
    if (!location) {
      return false;
    }

    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) {
      return false;
    }

    // Resolve followup event ID to canonical delegation conversation ID if needed
    const canonicalId = this.followupToCanonical.get(delegationConversationId)
      ?? delegationConversationId;

    const pendingDelegation = convDelegations.pending.get(canonicalId);
    return pendingDelegation?.killed === true;
  }

  /**
   * Mark all pending delegations for an agent+conversation as killed.
   * Used when killing an agent to prevent any of its delegations from completing.
   *
   * @returns The number of delegations marked as killed
   */
  markAllDelegationsKilled(agentPubkey: string, conversationId: string): number {
    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.conversationDelegations.get(key);
    if (!convDelegations) {
      return 0;
    }

    let killedCount = 0;
    const now = Date.now();

    for (const [delegationId, pendingDelegation] of convDelegations.pending) {
      if (!pendingDelegation.killed) {
        pendingDelegation.killed = true;
        pendingDelegation.killedAt = now;
        killedCount++;

        trace.getActiveSpan()?.addEvent("ral.delegation_marked_killed_bulk", {
          "delegation.conversation_id": shortenConversationId(delegationId),
          "delegation.recipient_pubkey": pendingDelegation.recipientPubkey.substring(0, 12),
        });
      }
    }

    if (killedCount > 0) {
      logger.info("[RALRegistry.markAllDelegationsKilled] Marked delegations as killed", {
        agentPubkey: agentPubkey.substring(0, 12),
        conversationId: conversationId.substring(0, 12),
        killedCount,
      });
    }

    return killedCount;
  }

  // ============================================================================
  // Heuristic Violation Methods (Namespaced State)
  // ============================================================================

  /**
   * Add heuristic violations to pending queue for a RAL.
   * These will be injected as system messages in the next LLM step.
   *
   * @param violations - Array of violations to add
   */
  addHeuristicViolations(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    violations: Array<{
      id: string;
      title: string;
      message: string;
      severity: "warning" | "error";
      timestamp: number;
      heuristicId: string;
    }>
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] Cannot add heuristic violations - no RAL state", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return;
    }

    // Initialize heuristics state if needed
    if (!ral.heuristics) {
      ral.heuristics = {
        pendingViolations: [],
        shownViolationIds: new Set(),
      };
    }

    // Filter out duplicates (already shown)
    const newViolations = violations.filter(
      (v) => !ral.heuristics!.shownViolationIds.has(v.id)
    );

    if (newViolations.length === 0) {
      return; // All violations already shown
    }

    // Add to pending queue
    ral.heuristics.pendingViolations.push(...newViolations);
    ral.lastActivityAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.heuristic_violations_added", {
      "ral.number": ralNumber,
      "heuristic.violation_count": newViolations.length,
      "heuristic.pending_count": ral.heuristics.pendingViolations.length,
    });
  }

  /**
   * Get and consume pending heuristic violations for injection.
   * Atomically reads and clears the pending queue, marks violations as shown.
   *
   * @returns Array of pending violations (empty if none)
   */
  getAndConsumeHeuristicViolations(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): Array<{
    id: string;
    title: string;
    message: string;
    severity: "warning" | "error";
    timestamp: number;
    heuristicId: string;
  }> {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral || !ral.heuristics || ral.heuristics.pendingViolations.length === 0) {
      return [];
    }

    // Atomic read+clear
    const violations = [...ral.heuristics.pendingViolations];
    ral.heuristics.pendingViolations = [];

    // Mark as shown (for deduplication)
    for (const v of violations) {
      ral.heuristics.shownViolationIds.add(v.id);
    }

    trace.getActiveSpan()?.addEvent("ral.heuristic_violations_consumed", {
      "ral.number": ralNumber,
      "heuristic.violation_count": violations.length,
    });

    return violations;
  }

  /**
   * Check if there are pending heuristic violations for a RAL.
   */
  hasPendingHeuristicViolations(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    return (ral?.heuristics?.pendingViolations?.length ?? 0) > 0;
  }

  // ============================================================================
  // Heuristic Helper Methods (BLOCKER 1 & 2 Fixes)
  // ============================================================================

  /**
   * Initialize heuristic state for a RAL entry (DRY helper).
   */
  private initializeHeuristicState(): NonNullable<RALRegistryEntry["heuristics"]> {
    return {
      pendingViolations: [],
      shownViolationIds: new Set(),
      summary: {
        recentTools: [],
        flags: {
          hasTodoWrite: false,
          hasDelegation: false,
          hasVerification: false,
          hasGitAgentCommit: false,
        },
        pendingDelegationCount: 0,
      },
      toolArgs: new Map(),
    };
  }

  /**
   * Store tool arguments by toolCallId for later retrieval by heuristics.
   * BLOCKER 2 FIX: Enables passing real args to heuristics, not result.
   */
  storeToolArgs(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    toolCallId: string,
    args: unknown
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return;

    if (!ral.heuristics) {
      ral.heuristics = this.initializeHeuristicState();
    }

    if (!ral.heuristics.toolArgs) {
      ral.heuristics.toolArgs = new Map();
    }

    ral.heuristics.toolArgs.set(toolCallId, args);
  }

  /**
   * Retrieve stored tool arguments by toolCallId.
   * BLOCKER 2 FIX: Returns real args stored at tool-will-execute.
   */
  getToolArgs(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    toolCallId: string
  ): unknown | undefined {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    return ral?.heuristics?.toolArgs?.get(toolCallId);
  }

  /**
   * Clear stored tool args for a specific toolCallId after evaluation.
   * Prevents memory leak by cleaning up after heuristic evaluation.
   */
  clearToolArgs(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    toolCallId: string
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral?.heuristics?.toolArgs) return;
    ral.heuristics.toolArgs.delete(toolCallId);
  }

  /**
   * Update O(1) precomputed summary for heuristic evaluation.
   * BLOCKER 1 FIX: Maintains O(1) context building with bounded history.
   *
   * @param maxRecentTools - Maximum recent tools to track (default: 10)
   */
  updateHeuristicSummary(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    toolName: string,
    toolArgs: unknown,
    maxRecentTools = 10
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return;

    if (!ral.heuristics) {
      ral.heuristics = this.initializeHeuristicState();
    }

    if (!ral.heuristics.summary) {
      ral.heuristics.summary = {
        recentTools: [],
        flags: {
          hasTodoWrite: false,
          hasDelegation: false,
          hasVerification: false,
          hasGitAgentCommit: false,
        },
        pendingDelegationCount: 0,
      };
    }

    const summary = ral.heuristics.summary;

    // Add to recent tools (bounded)
    summary.recentTools.push({ name: toolName, timestamp: Date.now() });
    if (summary.recentTools.length > maxRecentTools) {
      summary.recentTools.shift(); // Remove oldest
    }

    // Update flags based on tool name
    if (toolName === "TodoWrite" || toolName === "mcp__tenex__todo_write") {
      summary.flags.hasTodoWrite = true;
    }

    if (toolName === "mcp__tenex__delegate" || toolName === "mcp__tenex__delegate_crossproject") {
      summary.flags.hasDelegation = true;

      // Check if delegation to git-agent
      const args = toolArgs as { delegations?: Array<{ recipient?: string }> };
      if (args?.delegations?.some((d) => d.recipient === "git-agent")) {
        summary.flags.hasGitAgentCommit = true;
      }
    }

    if (toolName === "Bash") {
      const args = toolArgs as { command?: string };
      const command = args?.command?.toLowerCase() || "";

      // Check for verification commands
      if (
        command.includes("test") ||
        command.includes("build") ||
        command.includes("lint") ||
        command.includes("jest") ||
        command.includes("vitest")
      ) {
        summary.flags.hasVerification = true;
      }
    }
  }

  /**
   * Increment the pending delegation counter for a RAL.
   * Used when a new delegation is added in mergePendingDelegations.
   */
  private incrementDelegationCounter(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return;

    if (!ral.heuristics) {
      ral.heuristics = this.initializeHeuristicState();
    }

    if (!ral.heuristics.summary) {
      ral.heuristics.summary = {
        recentTools: [],
        flags: {
          hasTodoWrite: false,
          hasDelegation: false,
          hasVerification: false,
          hasGitAgentCommit: false,
        },
        pendingDelegationCount: 0,
      };
    }

    ral.heuristics.summary.pendingDelegationCount++;
  }

  /**
   * Decrement the pending delegation counter for a RAL.
   * Used when a delegation is completed.
   */
  private decrementDelegationCounter(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral?.heuristics?.summary) return;

    ral.heuristics.summary.pendingDelegationCount = Math.max(
      0,
      ral.heuristics.summary.pendingDelegationCount - 1
    );
  }

  /**
   * Get the O(1) precomputed summary for heuristic evaluation.
   * BLOCKER 1 FIX: Provides O(1) access to RAL state without scans.
   */
  getHeuristicSummary(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ):
    | {
        recentTools: Array<{ name: string; timestamp: number }>;
        flags: {
          hasTodoWrite: boolean;
          hasDelegation: boolean;
          hasVerification: boolean;
          hasGitAgentCommit: boolean;
        };
        pendingDelegationCount: number;
      }
    | undefined {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    return ral?.heuristics?.summary;
  }
}
