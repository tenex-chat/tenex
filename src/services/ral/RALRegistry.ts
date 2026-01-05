import { trace } from "@opentelemetry/api";
import { getPubkeyService } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import type {
  RALState,
  PendingDelegation,
  CompletedDelegation,
  QueuedInjection,
} from "./types";

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
export class RALRegistry {
  private static instance: RALRegistry;

  /**
   * RAL states keyed by "agentPubkey:conversationId", value is Map of ralNumber -> RALState
   * With simplified execution model, only one RAL is active per agent+conversation at a time.
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

  /** Delegations keyed by "agentPubkey:conversationId" - persists beyond RAL lifetime */
  private conversationDelegations: Map<string, {
    pending: Map<string, PendingDelegation>;
    completed: Map<string, CompletedDelegation>;
  }> = new Map();

  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Wake-up promises for RALs waiting on delegations/events. Keyed by "agentPubkey:conversationId:ralNumber" */
  private wakeUpPromises: Map<string, {
    promise: Promise<void>;
    resolver: () => void;
  }> = new Map();

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

  private getOrCreateConversationDelegations(key: string) {
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
   */
  create(
    agentPubkey: string,
    conversationId: string,
    originalTriggeringEventId?: string,
    traceContext?: { traceId: string; spanId: string }
  ): number {
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
      queuedInjections: [],
      isStreaming: false,
      createdAt: now,
      lastActivityAt: now,
      originalTriggeringEventId,
      traceId: traceContext?.traceId,
      executionSpanId: traceContext?.spanId,
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
   * Set pending delegations for a specific RAL (delegation tracking only, not message storage)
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
      }
    }

    // Add new pending delegations to conversation storage
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
   */
  recordCompletion(completion: {
    delegationConversationId: string;
    recipientPubkey: string;
    response: string;
    completedAt: number;
  }): { agentPubkey: string; conversationId: string; ralNumber: number } | undefined {
    const location = this.delegationToRal.get(completion.delegationConversationId);
    if (!location) return undefined;

    const [agentPubkey, conversationId] = location.key.split(":");
    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) return undefined;

    const pendingDelegation = convDelegations.pending.get(completion.delegationConversationId);
    if (!pendingDelegation) {
      logger.warn("[RALRegistry] No pending delegation found for completion", {
        delegationConversationId: completion.delegationConversationId.substring(0, 8),
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
    const existingCompletion = convDelegations.completed.get(completion.delegationConversationId);

    if (existingCompletion) {
      // Append the followup prompt and response to the transcript
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

      // Update ralNumber to the followup's RAL so findResumableRAL finds the correct RAL
      existingCompletion.ralNumber = pendingDelegation.ralNumber;

      trace.getActiveSpan()?.addEvent("ral.followup_response_appended", {
        "ral.id": ral?.id,
        "ral.number": location.ralNumber,
        "delegation.completed_conversation_id": completion.delegationConversationId,
        "delegation.transcript_length": existingCompletion.transcript.length,
      });
    } else {
      // Create new completed delegation with initial transcript
      convDelegations.completed.set(completion.delegationConversationId, {
        delegationConversationId: completion.delegationConversationId,
        recipientPubkey: completion.recipientPubkey,
        senderPubkey: pendingDelegation.senderPubkey,
        ralNumber: pendingDelegation.ralNumber,
        transcript: [
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
        ],
        completedAt: completion.completedAt,
      });

      const remainingPending = this.getConversationPendingDelegations(agentPubkey, conversationId, location.ralNumber).length - 1;
      trace.getActiveSpan()?.addEvent("ral.completion_recorded", {
        "ral.id": ral?.id,
        "ral.number": location.ralNumber,
        "delegation.completed_conversation_id": completion.delegationConversationId,
        "delegation.remaining_pending": remainingPending,
      });
    }

    // Remove from pending
    convDelegations.pending.delete(completion.delegationConversationId);

    return { agentPubkey, conversationId, ralNumber: location.ralNumber };
  }

  /**
   * Queue a system message for injection into a specific RAL
   */
  queueSystemMessage(agentPubkey: string, conversationId: string, ralNumber: number, message: string): void {
    this.queueMessage(agentPubkey, conversationId, ralNumber, "system", message);
  }

  /**
   * Queue a user message for injection into a specific RAL
   */
  queueUserMessage(agentPubkey: string, conversationId: string, ralNumber: number, message: string): void {
    this.queueMessage(agentPubkey, conversationId, ralNumber, "user", message);
  }

  /**
   * Queue a message with specified role for injection into a specific RAL
   */
  private queueMessage(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    role: "system" | "user",
    message: string
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
    });
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
   * Clear a specific RAL.
   * NOTE: Delegations persist in conversation storage - only clears RAL state.
   * The delegationToRal routing map stays intact for followup routing.
   */
  clearRAL(agentPubkey: string, conversationId: string, ralNumber: number): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (!rals) return;

    const ral = rals.get(ralNumber);
    if (ral) {
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
      for (const id of convDelegations.pending.keys()) {
        this.delegationToRal.delete(id);
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

    return {
      pending: convDelegations.pending.get(delegationEventId),
      completed: convDelegations.completed.get(delegationEventId),
      agentPubkey,
      conversationId,
      ralNumber: location.ralNumber,
    };
  }

  /**
   * Find the RAL that has a pending delegation (for routing responses)
   */
  findStateWaitingForDelegation(delegationEventId: string): RALState | undefined {
    const location = this.delegationToRal.get(delegationEventId);
    if (!location) return undefined;

    const ral = this.states.get(location.key)?.get(location.ralNumber);
    if (!ral) return undefined;

    // Check if delegation exists in conversation storage
    const convDelegations = this.conversationDelegations.get(location.key);
    const hasPending = convDelegations?.pending.has(delegationEventId) ?? false;
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
  findResumableRAL(agentPubkey: string, conversationId: string): RALState | undefined {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    return rals.find(ral => {
      const completed = this.getConversationCompletedDelegations(agentPubkey, conversationId, ral.ralNumber);
      return completed.length > 0;
    });
  }

  /**
   * Find a RAL that has queued injections ready to process.
   * Used for pairing checkpoint resumption - the supervisor has pending delegations
   * but received a checkpoint message that needs processing.
   */
  findRALWithInjections(agentPubkey: string, conversationId: string): RALState | undefined {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    return rals.find(ral => ral.queuedInjections.length > 0);
  }

  /**
   * Build a message containing delegation results for injection into the RAL.
   * Shows complete conversation transcript for each delegation.
   * Uses full delegation conversation IDs so agents can use them with delegate_followup.
   * Format: [@sender -> @recipient]: message content
   */
  async buildDelegationResultsMessage(
    completions: CompletedDelegation[],
    pending: PendingDelegation[] = []
  ): Promise<string> {
    if (completions.length === 0) {
      return "";
    }

    const pubkeyService = getPubkeyService();
    const lines: string[] = [];

    // Format completed delegations as conversation transcripts
    for (const c of completions) {
      lines.push(`# Delegation ID: ${c.delegationConversationId}`);
      lines.push("");

      for (const msg of c.transcript) {
        const senderName = await pubkeyService.getName(msg.senderPubkey);
        const recipientName = await pubkeyService.getName(msg.recipientPubkey);
        lines.push(`[@${senderName} -> @${recipientName}]: ${msg.content}`);
      }
      lines.push("");
    }

    // Only show pending section if there are any
    if (pending.length > 0) {
      lines.push("# Pending Delegations");
      for (const p of pending) {
        const recipientName = await pubkeyService.getName(p.recipientPubkey);
        lines.push(`- @${recipientName} (${p.delegationConversationId})`);
      }
      lines.push("");
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
   * Wait until this RAL is woken up by new message or delegation completion.
   * Blocks execution until wakeUp() is called.
   */
  async waitForWakeUp(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): Promise<void> {
    const key = `${this.makeKey(agentPubkey, conversationId)}:${ralNumber}`;

    // Create promise if doesn't exist
    if (!this.wakeUpPromises.has(key)) {
      let resolver: () => void;
      const promise = new Promise<void>(resolve => {
        resolver = resolve;
      });
      this.wakeUpPromises.set(key, {
        promise,
        resolver: resolver!
      });
    }

    trace.getActiveSpan()?.addEvent("ral.waiting_for_wakeup", {
      "ral.number": ralNumber,
      "agent.pubkey": agentPubkey.slice(0, 8),
    });

    await this.wakeUpPromises.get(key)!.promise;

    // Clean up after wake
    this.wakeUpPromises.delete(key);

    trace.getActiveSpan()?.addEvent("ral.woken_up", {
      "ral.number": ralNumber,
    });
  }

  /**
   * Wake up a waiting RAL (called when new message or delegation completes)
   */
  wakeUp(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): void {
    const key = `${this.makeKey(agentPubkey, conversationId)}:${ralNumber}`;
    const entry = this.wakeUpPromises.get(key);

    if (entry) {
      entry.resolver();
      trace.getActiveSpan()?.addEvent("ral.wake_triggered", {
        "ral.number": ralNumber,
        "agent.pubkey": agentPubkey.slice(0, 8),
      });
    }
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
          "conversation.id": conversationId.substring(0, 8),
        });
      }
    }

    // Clear all state for this agent+conversation
    this.clear(agentPubkey, conversationId);

    return abortedCount;
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
    this.wakeUpPromises.clear();
  }
}
