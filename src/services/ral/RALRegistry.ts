import { trace } from "@opentelemetry/api";
import { EventEmitter, type DefaultEventMap } from "tseep";
import { INJECTION_ABORT_REASON, llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { shortenConversationId, shortenPubkey } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import type { ProjectDTag } from "@/types/project-ids";
import type {
  InjectionResult,
  InjectionRole,
  RALRegistryEntry,
  PendingDelegation,
  CompletedDelegation,
  QueuedInjection,
  DelegationMessage,
} from "./types";
import { DelegationRegistry } from "./DelegationRegistry";
import { ExecutionTimingTracker } from "./ExecutionTimingTracker";
import { HeuristicViolationManager } from "./HeuristicViolationManager";
import { KillSwitchRegistry } from "./KillSwitchRegistry";
import { MessageInjectionQueue } from "./MessageInjectionQueue";

/** Events emitted by RALRegistry */
export type RALRegistryEvents = DefaultEventMap & {
  /** Emitted when any RAL state changes (streaming, tools, creation, cleanup) */
  updated: (...args: [projectId: ProjectDTag, conversationId: string]) => void;
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

  private readonly timingTracker: ExecutionTimingTracker;
  private readonly injectionQueue: MessageInjectionQueue;
  private readonly heuristicManager: HeuristicViolationManager;
  private readonly delegationRegistry: DelegationRegistry;
  private readonly killSwitchRegistry: KillSwitchRegistry;

  private constructor() {
    super();
    this.timingTracker = new ExecutionTimingTracker();
    this.injectionQueue = new MessageInjectionQueue(RALRegistry.MAX_QUEUE_SIZE);
    this.heuristicManager = new HeuristicViolationManager();
    this.delegationRegistry = new DelegationRegistry({
      getRAL: this.getRAL.bind(this),
      incrementDelegationCounter: this.incrementDelegationCounter.bind(this),
      decrementDelegationCounter: this.decrementDelegationCounter.bind(this),
    });
    this.killSwitchRegistry = new KillSwitchRegistry(
      {
        getState: this.getState.bind(this),
        getActiveRALs: this.getActiveRALs.bind(this),
        getAbortControllers: () => this.abortControllers,
        clearConversation: this.clear.bind(this),
        makeKey: this.makeKey.bind(this),
        makeAbortKey: this.makeAbortKey.bind(this),
      },
      this.delegationRegistry
    );
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
  private emitUpdated(projectId: ProjectDTag, conversationId: string): void {
    this.emit("updated", projectId, conversationId);
  }

  /**
   * Get pending delegations for a conversation, optionally filtered by RAL number
   */
  getConversationPendingDelegations(agentPubkey: string, conversationId: string, ralNumber?: number): PendingDelegation[] {
    return this.delegationRegistry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
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
    return this.delegationRegistry.mergePendingDelegations(
      agentPubkey,
      conversationId,
      ralNumber,
      newDelegations
    );
  }

  /**
   * Get completed delegations for a conversation, optionally filtered by RAL number
   */
  getConversationCompletedDelegations(agentPubkey: string, conversationId: string, ralNumber?: number): CompletedDelegation[] {
    return this.delegationRegistry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber);
  }

  /**
   * Clear completed delegations for a conversation, optionally filtered by RAL number.
   * Called after delegation markers have been inserted into ConversationStore
   * to prevent re-processing on subsequent executions.
   */
  clearCompletedDelegations(agentPubkey: string, conversationId: string, ralNumber?: number): void {
    this.delegationRegistry.clearCompletedDelegations(agentPubkey, conversationId, ralNumber);
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

    // ISSUE 1 FIX: Prune killed agent entries that correspond to cleaned states.
    // This prevents unbounded growth of the kill-switch marker set.
    // We prune keys that no longer have active RAL states - if there's no state,
    // the conversation is done and the kill marker is no longer needed.
    const prunedKilledCount = this.killSwitchRegistry.pruneStaleKilledConversations((key) => this.states.has(key));

    if (prunedKilledCount > 0) {
      logger.debug("[RALRegistry] Pruned stale killed agent entries", {
        prunedKilledCount,
        remainingKilledCount: this.killSwitchRegistry.getKilledConversationCount(),
      });
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
    projectId: ProjectDTag,
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
   * Request that the current RAL complete without a visible assistant response.
   */
  requestSilentCompletion(agentPubkey: string, conversationId: string, ralNumber: number): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      return false;
    }

    const requestedAt = Date.now();
    ral.silentCompletionRequestedAt = requestedAt;
    ral.lastActivityAt = requestedAt;

    trace.getActiveSpan()?.addEvent("ral.silent_completion_requested", {
      "ral.number": ralNumber,
      "agent.pubkey": agentPubkey,
      "conversation.id": shortenConversationId(conversationId),
    });

    this.emitUpdated(ral.projectId, conversationId);
    return true;
  }

  /**
   * Check whether the current RAL has an outstanding silent-completion request.
   */
  isSilentCompletionRequested(agentPubkey: string, conversationId: string, ralNumber: number): boolean {
    return this.getRAL(agentPubkey, conversationId, ralNumber)?.silentCompletionRequestedAt !== undefined;
  }

  /**
   * Clear a silent-completion request for the current RAL.
   */
  clearSilentCompletionRequest(agentPubkey: string, conversationId: string, ralNumber: number): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral || ral.silentCompletionRequestedAt === undefined) {
      return false;
    }

    ral.silentCompletionRequestedAt = undefined;
    ral.lastActivityAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.silent_completion_cleared", {
      "ral.number": ralNumber,
      "agent.pubkey": agentPubkey,
      "conversation.id": shortenConversationId(conversationId),
    });

    this.emitUpdated(ral.projectId, conversationId);
    return true;
  }

  /**
   * Mark the start of an LLM streaming session.
   * Call this immediately before llmService.stream() to begin timing.
   *
   * @param lastUserMessage - The last user message that triggered this LLM call (for debugging)
   */
  startLLMStream(agentPubkey: string, conversationId: string, ralNumber: number, lastUserMessage?: string): void {
    this.timingTracker.startLLMStream(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber,
      lastUserMessage
    );
  }

  /**
   * Mark the end of an LLM streaming session and accumulate the runtime.
   * Call this in the finally block after llmService.stream() completes.
   * @returns The total accumulated runtime in milliseconds
   */
  endLLMStream(agentPubkey: string, conversationId: string, ralNumber: number): number {
    return this.timingTracker.endLLMStream(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber
    );
  }

  /**
   * Get the accumulated LLM runtime for a RAL
   */
  getAccumulatedRuntime(agentPubkey: string, conversationId: string, ralNumber: number): number {
    return this.timingTracker.getAccumulatedRuntime(this.getRAL(agentPubkey, conversationId, ralNumber));
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
    return this.timingTracker.consumeUnreportedRuntime(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber
    );
  }

  /**
   * Get the unreported runtime without consuming it.
   * Use consumeUnreportedRuntime() when publishing events.
   *
   * NOTE: This also calculates "live" runtime during active streams for accurate preview.
   */
  getUnreportedRuntime(agentPubkey: string, conversationId: string, ralNumber: number): number {
    return this.timingTracker.getUnreportedRuntime(this.getRAL(agentPubkey, conversationId, ralNumber));
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
    this.delegationRegistry.setPendingDelegations(
      agentPubkey,
      conversationId,
      ralNumber,
      pendingDelegations
    );
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
    return this.delegationRegistry.recordCompletion(completion);
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

    this.injectionQueue.queueMessage(activeRal, agentPubkey, conversationId, activeRal.ralNumber, role, message);

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
    this.injectionQueue.queueSystemMessage(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber,
      message
    );
  }

  /**
   * Queue a user message for injection into a specific RAL
   */
  queueUserMessage(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    message: string,
    options?: {
      senderPubkey?: string;
      senderPrincipal?: QueuedInjection["senderPrincipal"];
      targetedPrincipals?: QueuedInjection["targetedPrincipals"];
      eventId?: string;
    }
  ): void {
    this.injectionQueue.queueUserMessage(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber,
      message,
      options
    );
  }

  /**
   * Get and consume queued injections for a specific RAL
   * Injections are persisted to ConversationStore by the caller
   */
  getAndConsumeInjections(agentPubkey: string, conversationId: string, ralNumber: number): QueuedInjection[] {
    return this.injectionQueue.getAndConsumeInjections(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber
    );
  }

  /**
   * Clear a specific queued injection identified by its source event ID.
   * Used after a live MessageInjector delivery succeeds so unrelated queued
   * follow-ups remain pending for the same conversation.
   */
  clearQueuedInjectionByEventId(agentPubkey: string, conversationId: string, eventId: string): number {
    return this.injectionQueue.clearQueuedInjectionByEventId(
      this.states.get(this.makeKey(agentPubkey, conversationId))?.values(),
      agentPubkey,
      conversationId,
      eventId
    );
  }

  /**
   * Clear all queued injections for an agent's conversation.
   * Called by AgentDispatchService after MessageInjector successfully delivers a message.
   * This prevents hasOutstandingWork() from incorrectly reporting queued injections
   * that have already been delivered, which would cause the agent to use conversation()
   * instead of complete().
   */
  clearQueuedInjections(agentPubkey: string, conversationId: string): void {
    this.injectionQueue.clearQueuedInjections(
      this.states.get(this.makeKey(agentPubkey, conversationId))?.values(),
      agentPubkey,
      conversationId
    );
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
      if (!toolName) {
        throw new Error(`[RALRegistry] Missing tool name for toolCallId ${toolCallId} in conversation ${shortenConversationId(conversationId)}.`);
      }
      // Store toolCallId -> tool info mapping (name + startedAt)
      const now = Date.now();
      ral.activeTools.set(toolCallId, { name: toolName, startedAt: now });
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
   * Also cleans up conversation-level delegation storage and killed markers.
   */
  clear(agentPubkey: string, conversationId: string): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (rals) {
      for (const ralNumber of rals.keys()) {
        this.clearRAL(agentPubkey, conversationId, ralNumber);
      }
    }
    this.killSwitchRegistry.clearConversation(agentPubkey, conversationId);
    this.delegationRegistry.clearConversation(agentPubkey, conversationId);
    // Reset the RAL number counter for this conversation
    this.nextRalNumber.delete(key);
  }

  /**
   * Resolve a 12-character hex prefix to a full delegation conversation ID.
   * Scans all pending and completed delegations for matching prefixes,
   * including followup event IDs which users may also receive and try to use.
   *
   * This is a fallback resolver for edge cases where PrefixKVStore is not initialized
   * (MCP-only execution mode) or when there are timing races with event indexing.
   *
   * Supports resolving:
   * - Delegation conversation IDs (from pending/completed maps)
   * - Followup event IDs (from followupToCanonical map) - resolved to their canonical delegation ID
   *
   * @param prefix - 12-character hex prefix (must be lowercase)
   * @returns Full 64-char ID if unique match found, null if no match or ambiguous
   */
  resolveDelegationPrefix(prefix: string): string | null {
    return this.delegationRegistry.resolveDelegationPrefix(prefix);
  }

  /**
   * Canonicalize a delegation ID by resolving followup event IDs to their canonical
   * delegation conversation IDs. If the ID is not a followup event ID, returns it unchanged.
   *
   * This is used as a post-resolution step when PrefixKVStore resolves an ID that may
   * be a followup event ID. PrefixKVStore returns any matching ID, but delegate_followup
   * needs the canonical delegation conversation ID for proper routing and e-tags.
   *
   * Resolution order:
   * 1. Check followupToCanonical map (O(1) lookup for known followup IDs)
   * 2. Scan pending/completed delegations for followup entries with matching followupEventId
   * 3. Return unchanged if not found (treat as canonical)
   *
   * This handles edge cases where:
   * - MCP-only mode: followupToCanonical map may not be populated
   * - Cross-session: followup was created in a previous session and RAL state was cleared
   * - Full 64-char hex IDs provided directly instead of via prefix resolution
   *
   * @param id - A delegation conversation ID or followup event ID (64-char hex)
   * @returns The canonical delegation conversation ID (unchanged if not a followup)
   */
  canonicalizeDelegationId(id: string): string {
    return this.delegationRegistry.canonicalizeDelegationId(id);
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
    return this.delegationRegistry.findDelegation(delegationEventId);
  }

  /**
   * Find the RAL that has a pending delegation (for routing responses)
   * Handles both original delegation IDs and followup event IDs through the reverse lookup.
   */
  findStateWaitingForDelegation(delegationEventId: string): RALRegistryEntry | undefined {
    return this.delegationRegistry.findStateWaitingForDelegation(delegationEventId);
  }

  /**
   * Get the RAL key for a delegation event ID (for routing completions)
   */
  getRalKeyForDelegation(delegationEventId: string): string | undefined {
    return this.delegationRegistry.getRalKeyForDelegation(delegationEventId);
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
   * Abort current tool on most recent RAL (convenience for tests)
   */
  abortCurrentTool(agentPubkey: string, conversationId: string): void {
    this.killSwitchRegistry.abortCurrentTool(agentPubkey, conversationId);
  }

  /**
   * Abort all running RALs for an agent in a conversation.
   * This is used when a stop signal is received to immediately terminate all executions.
   */
  abortAllForAgent(agentPubkey: string, conversationId: string): number {
    return this.killSwitchRegistry.abortAllForAgent(agentPubkey, conversationId);
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
    projectId: ProjectDTag,
    reason: string,
    cooldownRegistry?: { add: (projectId: ProjectDTag, convId: string, agentPubkey: string, reason: string) => void }
  ): Promise<{ abortedCount: number; descendantConversations: Array<{ conversationId: string; agentPubkey: string }> }> {
    return this.killSwitchRegistry.abortWithCascade(
      agentPubkey,
      conversationId,
      projectId,
      reason,
      cooldownRegistry
    );
  }

  /**
   * Clear all state (for testing)
   */
  clearAll(): void {
    this.states.clear();
    this.nextRalNumber.clear();
    this.ralIdToLocation.clear();
    this.abortControllers.clear();
    this.delegationRegistry.clearAll();
    this.killSwitchRegistry.clearAll();
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
    return this.killSwitchRegistry.markDelegationKilled(delegationConversationId);
  }

  /**
   * Check if a delegation has been marked as killed.
   * Used by completion handlers to skip processing killed delegations.
   *
   * @param delegationConversationId - The delegation conversation ID to check
   * @returns true if the delegation is killed, false if not found or not killed
   */
  isDelegationKilled(delegationConversationId: string): boolean {
    return this.killSwitchRegistry.isDelegationKilled(delegationConversationId);
  }

  /**
   * Mark all pending delegations for an agent+conversation as killed.
   * Used when killing an agent to prevent any of its delegations from completing.
   *
   * @returns The number of delegations marked as killed
   */
  markAllDelegationsKilled(agentPubkey: string, conversationId: string): number {
    return this.killSwitchRegistry.markAllDelegationsKilled(agentPubkey, conversationId);
  }

  /**
   * Mark an agent+conversation as killed.
   * Used to prevent killed agents from publishing completion events.
   * This addresses the race condition where an agent continues running
   * (e.g., in a long tool execution) after being killed.
   *
   * ISSUE 3 FIX: Scoped to agentPubkey:conversationId to ensure killing one
   * agent doesn't suppress completions for other agents in the same conversation.
   *
   * @param agentPubkey - The agent's pubkey
   * @param conversationId - The conversation ID
   */
  markAgentConversationKilled(agentPubkey: string, conversationId: string): void {
    this.killSwitchRegistry.markAgentConversationKilled(agentPubkey, conversationId);
  }

  /**
   * Check if an agent+conversation has been killed.
   * Used by AgentPublisher to skip completion events for killed agents.
   *
   * ISSUE 3 FIX: Scoped to agentPubkey:conversationId to ensure killing one
   * agent doesn't suppress completions for other agents in the same conversation.
   *
   * @param agentPubkey - The agent's pubkey
   * @param conversationId - The conversation ID
   * @returns true if the agent+conversation has been killed
   */
  isAgentConversationKilled(agentPubkey: string, conversationId: string): boolean {
    return this.killSwitchRegistry.isAgentConversationKilled(agentPubkey, conversationId);
  }

  /**
   * Look up the recipient agent pubkey for a PENDING delegation conversation.
   * Uses the delegationToRal map to find the parent, then looks up the pending delegation
   * to find the recipient.
   *
   * IMPORTANT: This method ONLY returns pubkeys for pending delegations. Completed
   * delegations are intentionally excluded to prevent pre-emptive kill from succeeding
   * on already-completed delegations (which would be a no-op that adds unnecessary
   * cooldown entries and misleading success messages).
   *
   * @param delegationConversationId - The delegation conversation ID
   * @returns The recipient agent pubkey if delegation is PENDING, or null if not found or completed
   */
  getDelegationRecipientPubkey(delegationConversationId: string): string | null {
    return this.killSwitchRegistry.getDelegationRecipientPubkey(delegationConversationId);
  }

  /**
   * Mark the parent's pending delegation as killed when killing a child conversation.
   * Uses the delegationToRal map to find the parent that owns this delegation.
   *
   * This fixes the bug where Agent0's pending_delegations count remains at 1
   * after killing a delegation, because the parent's state wasn't updated.
   *
   * @param delegationConversationId - The delegation conversation ID being killed
   * @returns true if parent delegation was found and marked, false otherwise
   */
  markParentDelegationKilled(delegationConversationId: string): boolean {
    return this.killSwitchRegistry.markParentDelegationKilled(delegationConversationId);
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
    this.heuristicManager.addHeuristicViolations(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber,
      violations
    );
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
    return this.heuristicManager.getAndConsumeHeuristicViolations(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber
    );
  }

  /**
   * Check if there are pending heuristic violations for a RAL.
   */
  hasPendingHeuristicViolations(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): boolean {
    return this.heuristicManager.hasPendingHeuristicViolations(
      this.getRAL(agentPubkey, conversationId, ralNumber)
    );
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
    this.heuristicManager.storeToolArgs(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber,
      toolCallId,
      args
    );
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
    return this.heuristicManager.getToolArgs(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber,
      toolCallId
    );
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
    this.heuristicManager.clearToolArgs(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber,
      toolCallId
    );
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
    this.heuristicManager.updateHeuristicSummary(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber,
      toolName,
      toolArgs,
      maxRecentTools
    );
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
    this.heuristicManager.incrementDelegationCounter(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber
    );
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
    this.heuristicManager.decrementDelegationCounter(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber
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
    return this.heuristicManager.getHeuristicSummary(
      this.getRAL(agentPubkey, conversationId, ralNumber),
      agentPubkey,
      conversationId,
      ralNumber
    );
  }

  // ============================================================================
  // Outstanding Work Detection (Race Condition Prevention)
  // ============================================================================

  /**
   * Check if there's any outstanding work for a conversation that would prevent finalization.
   *
   * This method consolidates checking for:
   * 1. Queued injections (messages waiting to be processed in the next LLM step)
   * 2. Pending delegations (delegations that haven't completed yet)
   * 3. Completed delegations (delegations that completed but whose results haven't
   *    been incorporated into the agent's messages via resolveRAL yet)
   *
   * Checking completed delegations is critical for fast-completing delegations:
   * recordCompletion() moves delegations from pending→completed immediately (no debounce),
   * but the executor only processes them via resolveRAL() after the debounce fires.
   * Without this check, the executor sees pendingDelegations=0 and finalizes prematurely,
   * clearing the RAL before the completed delegation can be processed.
   *
   * @param agentPubkey - The agent's pubkey
   * @param conversationId - The conversation ID
   * @param ralNumber - The RAL number to check
   * @returns Object indicating if there's outstanding work and details about it
   */
  hasOutstandingWork(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): {
    hasWork: boolean;
    details: {
      queuedInjections: number;
      pendingDelegations: number;
      completedDelegations: number;
    };
  } {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);

    // Count pending delegations from conversation storage (independent of RAL existence)
    // Pending delegations persist in conversationDelegations map which is separate from RAL state
    const pendingDelegations = this.getConversationPendingDelegations(
      agentPubkey,
      conversationId,
      ralNumber
    ).length;

    // Count completed delegations that haven't been consumed by resolveRAL yet.
    // These are delegations where recordCompletion() has run but the executor hasn't
    // processed them into conversation markers yet.
    const completedDelegations = this.getConversationCompletedDelegations(
      agentPubkey,
      conversationId,
      ralNumber
    ).length;

    // If RAL doesn't exist, we can't have queued injections but may still have delegations
    if (!ral) {
      const hasWork = pendingDelegations > 0 || completedDelegations > 0;
      if (hasWork) {
        trace.getActiveSpan()?.addEvent("ral.outstanding_work_no_ral", {
          "ral.number": ralNumber,
          "outstanding.pending_delegations": pendingDelegations,
          "outstanding.completed_delegations": completedDelegations,
          "agent.pubkey": shortenPubkey(agentPubkey),
          "conversation.id": shortenConversationId(conversationId),
        });
      }
      return {
        hasWork,
        details: {
          queuedInjections: 0,
          pendingDelegations,
          completedDelegations,
        },
      };
    }

    // Count queued injections from the RAL entry
    const queuedInjections = ral.queuedInjections.length;

    const hasWork = queuedInjections > 0 || pendingDelegations > 0 || completedDelegations > 0;

    // Add telemetry for debugging race conditions
    if (hasWork) {
      trace.getActiveSpan()?.addEvent("ral.outstanding_work_detected", {
        "ral.number": ralNumber,
        "outstanding.queued_injections": queuedInjections,
        "outstanding.pending_delegations": pendingDelegations,
        "outstanding.completed_delegations": completedDelegations,
        "agent.pubkey": shortenPubkey(agentPubkey),
        "conversation.id": shortenConversationId(conversationId),
      });
    }

    return {
      hasWork,
      details: {
        queuedInjections,
        pendingDelegations,
        completedDelegations,
      },
    };
  }

  // ============================================================================
  // Graceful Restart Support
  // ============================================================================

  /**
   * Get the total count of active RALs across all conversations.
   * Used by the daemon to determine when it's safe to perform a graceful restart.
   *
   * A RAL is considered "active" if it exists in the states map, meaning:
   * - An agent execution is in progress (streaming, tool execution, etc.)
   * - An agent is waiting on pending delegations
   *
   * @returns Total count of active RALs
   */
  getTotalActiveCount(): number {
    let totalCount = 0;
    for (const rals of this.states.values()) {
      totalCount += rals.size;
    }
    return totalCount;
  }

  /**
   * Get all active RALs for a specific conversation (across all agents).
   * Used by the kill tool to find active agents in a conversation.
   *
   * @param conversationId - The conversation ID to search for
   * @returns Array of RAL entries with their agent pubkeys
   */
  getActiveRalsForConversation(conversationId: string): Array<{ agentPubkey: string; ralNumber: number }> {
    const results: Array<{ agentPubkey: string; ralNumber: number }> = [];

    for (const [key, rals] of this.states) {
      // Key format: "agentPubkey:conversationId"
      const [agentPubkey, convId] = key.split(":");
      if (convId === conversationId) {
        for (const ralNumber of rals.keys()) {
          results.push({ agentPubkey, ralNumber });
        }
      }
    }

    return results;
  }

  /**
   * Get all active RAL entries for a specific project.
   * Used by the active-conversations prompt fragment to show concurrent activity.
   *
   * @param projectId - The project ID to filter by
   * @returns Array of active RAL entries for the project
   */
  getActiveEntriesForProject(projectId: ProjectDTag): RALRegistryEntry[] {
    const results: RALRegistryEntry[] = [];

    for (const rals of this.states.values()) {
      for (const ral of rals.values()) {
        if (ral.projectId === projectId) {
          results.push(ral);
        }
      }
    }

    return results;
  }
}
