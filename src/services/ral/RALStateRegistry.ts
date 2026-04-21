import { trace } from "@opentelemetry/api";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { shortenConversationId, shortenPubkey } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import type { ProjectDTag } from "@/types/project-ids";
import type { CompletedDelegation, PendingDelegation, RALRegistryEntry } from "./types";

interface RALStateRegistryDeps {
  emitUpdated: (projectId: ProjectDTag, conversationId: string) => void;
  getConversationPendingDelegations: (
    agentPubkey: string,
    conversationId: string,
    ralNumber?: number
  ) => PendingDelegation[];
  getConversationCompletedDelegations: (
    agentPubkey: string,
    conversationId: string,
    ralNumber?: number
  ) => CompletedDelegation[];
  pruneKilledConversationKeys: (hasState: (key: string) => boolean) => number;
  getKilledConversationCount: () => number;
}

/**
 * RALStateRegistry - owns the live RAL maps and the core lifecycle/tool-state logic.
 */
export class RALStateRegistry {
  private static readonly STATE_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

  private readonly states: Map<string, Map<number, RALRegistryEntry>> = new Map();
  private readonly nextRalNumber: Map<string, number> = new Map();
  private readonly ralIdToLocation: Map<string, { key: string; ralNumber: number }> = new Map();
  private readonly abortControllers: Map<string, AbortController> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RALStateRegistryDeps) {}

  get statesMap(): Map<string, Map<number, RALRegistryEntry>> {
    return this.states;
  }

  get nextRalNumberMap(): Map<string, number> {
    return this.nextRalNumber;
  }

  get ralIdToLocationMap(): Map<string, { key: string; ralNumber: number }> {
    return this.ralIdToLocation;
  }

  get abortControllersMap(): Map<string, AbortController> {
    return this.abortControllers;
  }

  getAbortControllers(): Map<string, AbortController> {
    return this.abortControllers;
  }

  makeKey(agentPubkey: string, conversationId: string): string {
    return `${agentPubkey}:${conversationId}`;
  }

  makeAbortKey(key: string, ralNumber: number): string {
    return `${key}:${ralNumber}`;
  }

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

    let rals = this.states.get(key);
    if (!rals) {
      rals = new Map();
      this.states.set(key, rals);
    }
    rals.set(ralNumber, state);
    this.ralIdToLocation.set(id, { key, ralNumber });

    trace.getActiveSpan()?.addEvent("ral.created", {
      "ral.id": id,
      "ral.number": ralNumber,
      "agent.pubkey": agentPubkey,
      "conversation.id": shortenConversationId(conversationId),
    });

    logger.info("[RALStateRegistry.create] RAL created", {
      ralNumber,
      agentPubkey: agentPubkey.substring(0, 8),
      conversationId: conversationId.substring(0, 8),
      projectId: projectId.substring(0, 20),
      key,
    });

    this.deps.emitUpdated(projectId, conversationId);
    return ralNumber;
  }

  seed(
    params: {
      agentPubkey: string;
      conversationId: string;
      projectId: ProjectDTag;
      ralNumber: number;
      originalTriggeringEventId?: string;
      executionClaimToken?: string;
    }
  ): RALRegistryEntry {
    const now = Date.now();
    const key = this.makeKey(params.agentPubkey, params.conversationId);
    const existing = this.states.get(key)?.get(params.ralNumber);
    if (existing) {
      if (params.executionClaimToken && existing.executionClaimToken === undefined) {
        existing.executionClaimToken = params.executionClaimToken;
      }
      existing.lastActivityAt = now;
      return existing;
    }

    const id = crypto.randomUUID();
    const state: RALRegistryEntry = {
      id,
      ralNumber: params.ralNumber,
      agentPubkey: params.agentPubkey,
      projectId: params.projectId,
      conversationId: params.conversationId,
      queuedInjections: [],
      isStreaming: false,
      activeTools: new Map(),
      createdAt: now,
      lastActivityAt: now,
      originalTriggeringEventId: params.originalTriggeringEventId,
      executionClaimToken: params.executionClaimToken,
      accumulatedRuntime: 0,
      lastReportedRuntime: 0,
    };

    let rals = this.states.get(key);
    if (!rals) {
      rals = new Map();
      this.states.set(key, rals);
    }
    rals.set(params.ralNumber, state);
    this.ralIdToLocation.set(id, { key, ralNumber: params.ralNumber });

    const currentNext = this.nextRalNumber.get(key) || 0;
    if (params.ralNumber > currentNext) {
      this.nextRalNumber.set(key, params.ralNumber);
    }

    trace.getActiveSpan()?.addEvent("ral.seeded", {
      "ral.id": id,
      "ral.number": params.ralNumber,
      "agent.pubkey": params.agentPubkey,
      "conversation.id": shortenConversationId(params.conversationId),
      "claim.present": params.executionClaimToken !== undefined,
    });

    logger.info("[RALStateRegistry.seed] RAL seeded", {
      ralNumber: params.ralNumber,
      agentPubkey: params.agentPubkey.substring(0, 8),
      conversationId: params.conversationId.substring(0, 8),
      projectId: params.projectId.substring(0, 20),
      key,
    });

    this.deps.emitUpdated(params.projectId, params.conversationId);
    return state;
  }

  getActiveRALs(agentPubkey: string, conversationId: string): RALRegistryEntry[] {
    const key = this.makeKey(agentPubkey, conversationId);
    return Array.from(this.states.get(key)?.values() ?? []);
  }

  getRAL(agentPubkey: string, conversationId: string, ralNumber: number): RALRegistryEntry | undefined {
    return this.states.get(this.makeKey(agentPubkey, conversationId))?.get(ralNumber);
  }

  getStateByRalId(ralId: string): RALRegistryEntry | undefined {
    const location = this.ralIdToLocation.get(ralId);
    return location ? this.states.get(location.key)?.get(location.ralNumber) : undefined;
  }

  getState(agentPubkey: string, conversationId: string): RALRegistryEntry | undefined {
    const rals = this.states.get(this.makeKey(agentPubkey, conversationId));
    if (!rals || rals.size === 0) return undefined;
    let maxRal: RALRegistryEntry | undefined;
    for (const ral of rals.values()) {
      if (!maxRal || ral.ralNumber > maxRal.ralNumber) {
        maxRal = ral;
      }
    }
    return maxRal;
  }

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

  setStreaming(agentPubkey: string, conversationId: string, ralNumber: number, isStreaming: boolean): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return;

    ral.isStreaming = isStreaming;
    ral.lastActivityAt = Date.now();
    const newState: "STREAMING" | "ACTING" | "REASONING" = isStreaming
      ? "STREAMING"
      : ral.activeTools.size > 0
        ? "ACTING"
        : "REASONING";

    llmOpsRegistry.updateRALState(agentPubkey, conversationId, newState);
    this.deps.emitUpdated(ral.projectId, conversationId);
  }

  /**
   * Synchronously attempt to claim an idle RAL for resumption.
   *
   * This is the serialization point that prevents two concurrent dispatches
   * from both invoking `resolveRAL` on the same resumable RAL. Bun's event
   * loop is single-threaded, so the read-check-and-set in this method is
   * atomic relative to other registry callers: no `await` exists between
   * observing `isStreaming`/`executionClaimToken` and assigning the token.
   *
   * The claim succeeds only if the RAL exists, is not already streaming, and
   * is not already claimed by another dispatch. A successful claim returns an
   * opaque token; the caller MUST eventually pair it with exactly one of:
   *   - `releaseResumptionClaim(token)` on an early-failure path, or
   *   - `handOffResumptionClaimToStream(token)` once the stream-execution
   *     handler has set `isStreaming = true` and taken ownership.
   *
   * Returns `undefined` if the claim cannot be acquired.
   */
  tryAcquireResumptionClaim(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): string | undefined {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return undefined;
    if (ral.isStreaming) return undefined;
    if (ral.executionClaimToken !== undefined) return undefined;

    const token = crypto.randomUUID();
    ral.executionClaimToken = token;
    ral.lastActivityAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.resumption_claim_acquired", {
      "ral.number": ralNumber,
      "ral.id": ral.id,
      "claim.token": token,
    });

    return token;
  }

  /**
   * Release a resumption claim acquired via `tryAcquireResumptionClaim`.
   *
   * Only releases the claim if the provided token still matches the RAL's
   * current token. This prevents a late-arriving release from the original
   * claimant (e.g. a `finally` block running after cleanup) from accidentally
   * clearing a claim that was re-acquired by a subsequent dispatch.
   *
   * Returns true if the claim was released, false if the token no longer
   * matches (another claim is active) or if the RAL is gone.
   */
  releaseResumptionClaim(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    token: string
  ): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return false;
    if (ral.executionClaimToken !== token) return false;

    ral.executionClaimToken = undefined;
    ral.lastActivityAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.resumption_claim_released", {
      "ral.number": ralNumber,
      "ral.id": ral.id,
      "claim.token": token,
    });

    return true;
  }

  /**
   * Hand off a resumption claim to the stream execution handler.
   *
   * Called by `StreamExecutionHandler.execute()` immediately after it flips
   * `isStreaming` to true: at that point the stream has become the authoritative
   * owner of the RAL's busy state, and the claim token is redundant. This
   * method atomically clears the token so that the dispatch-scope finally
   * block (which uses `releaseResumptionClaim(token)`) will no-op, and
   * subsequent dispatches are now serialized by the live `isStreaming` flag.
   *
   * Returns true if the handoff happened, false if the token no longer matches.
   */
  handOffResumptionClaimToStream(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    token: string
  ): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return false;
    if (ral.executionClaimToken !== token) return false;

    ral.executionClaimToken = undefined;
    ral.lastActivityAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.resumption_claim_handed_off", {
      "ral.number": ralNumber,
      "ral.id": ral.id,
      "claim.token": token,
    });

    return true;
  }

  requestSilentCompletion(agentPubkey: string, conversationId: string, ralNumber: number): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return false;

    const requestedAt = Date.now();
    ral.silentCompletionRequestedAt = requestedAt;
    ral.lastActivityAt = requestedAt;

    trace.getActiveSpan()?.addEvent("ral.silent_completion_requested", {
      "ral.number": ralNumber,
      "agent.pubkey": agentPubkey,
      "conversation.id": shortenConversationId(conversationId),
    });

    this.deps.emitUpdated(ral.projectId, conversationId);
    return true;
  }

  isSilentCompletionRequested(agentPubkey: string, conversationId: string, ralNumber: number): boolean {
    return this.getRAL(agentPubkey, conversationId, ralNumber)?.silentCompletionRequestedAt !== undefined;
  }

  clearSilentCompletionRequest(agentPubkey: string, conversationId: string, ralNumber: number): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral || ral.silentCompletionRequestedAt === undefined) return false;

    ral.silentCompletionRequestedAt = undefined;
    ral.lastActivityAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.silent_completion_cleared", {
      "ral.number": ralNumber,
      "agent.pubkey": agentPubkey,
      "conversation.id": shortenConversationId(conversationId),
    });

    this.deps.emitUpdated(ral.projectId, conversationId);
    return true;
  }

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
      const now = Date.now();
      ral.activeTools.set(toolCallId, { name: toolName, startedAt: now });
      ral.toolStartedAt = now;
      ral.currentTool = toolName;
    } else {
      ral.activeTools.delete(toolCallId);
      if (ral.activeTools.size === 0) {
        ral.currentTool = undefined;
        ral.toolStartedAt = undefined;
      } else {
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
    const newState: "ACTING" | "STREAMING" | "REASONING" = ral.activeTools.size > 0
      ? "ACTING"
      : ral.isStreaming
        ? "STREAMING"
        : "REASONING";

    llmOpsRegistry.updateRALState(agentPubkey, conversationId, newState);
    this.deps.emitUpdated(ral.projectId, conversationId);

    trace.getActiveSpan()?.addEvent(isActive ? "ral.tool_started" : "ral.tool_completed", {
      "ral.number": ralNumber,
      "tool.call_id": toolCallId,
      "tool.name": toolName,
      "ral.active_tools_count": ral.activeTools.size,
    });
  }

  clearToolFallback(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    toolCallId: string
  ): boolean {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral || !ral.activeTools.has(toolCallId)) return false;

    ral.activeTools.delete(toolCallId);
    ral.lastActivityAt = Date.now();

    if (ral.activeTools.size === 0) {
      ral.currentTool = undefined;
      ral.toolStartedAt = undefined;
    } else {
      const remainingToolInfo = ral.activeTools.values().next().value;
      if (remainingToolInfo) {
        ral.currentTool = remainingToolInfo.name;
        ral.toolStartedAt = remainingToolInfo.startedAt;
      } else {
        ral.currentTool = undefined;
        ral.toolStartedAt = undefined;
      }
    }

    const newState: "ACTING" | "STREAMING" | "REASONING" = ral.activeTools.size > 0
      ? "ACTING"
      : ral.isStreaming
        ? "STREAMING"
        : "REASONING";

    llmOpsRegistry.updateRALState(agentPubkey, conversationId, newState);
    this.deps.emitUpdated(ral.projectId, conversationId);

    trace.getActiveSpan()?.addEvent("ral.tool_cleared_fallback", {
      "ral.number": ralNumber,
      "tool.call_id": toolCallId,
      "ral.active_tools_count": ral.activeTools.size,
    });

    return true;
  }

  registerAbortController(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    controller: AbortController
  ): void {
    this.abortControllers.set(this.makeAbortKey(this.makeKey(agentPubkey, conversationId), ralNumber), controller);
  }

  clearRAL(agentPubkey: string, conversationId: string, ralNumber: number): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (!rals) return;

    const ral = rals.get(ralNumber);
    const projectId = ral?.projectId;
    if (ral) {
      this.ralIdToLocation.delete(ral.id);
    }

    rals.delete(ralNumber);
    this.abortControllers.delete(this.makeAbortKey(key, ralNumber));

    if (rals.size === 0) {
      this.states.delete(key);
    }

    trace.getActiveSpan()?.addEvent("ral.cleared", {
      "ral.number": ralNumber,
    });

    if (projectId) {
      this.deps.emitUpdated(projectId, conversationId);
    }
  }

  clear(agentPubkey: string, conversationId: string): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const rals = this.states.get(key);
    if (rals) {
      for (const ralNumber of rals.keys()) {
        this.clearRAL(agentPubkey, conversationId, ralNumber);
      }
    }
    this.nextRalNumber.delete(key);
  }

  findResumableRAL(agentPubkey: string, conversationId: string): RALRegistryEntry | undefined {
    const rals = this.getActiveRALs(agentPubkey, conversationId);
    return rals.find((ral) => this.deps.getConversationCompletedDelegations(agentPubkey, conversationId, ral.ralNumber).length > 0);
  }

  findRALWithInjections(agentPubkey: string, conversationId: string): RALRegistryEntry | undefined {
    return this.getActiveRALs(agentPubkey, conversationId).find((ral) => ral.queuedInjections.length > 0);
  }

  shouldWakeUpExecution(agentPubkey: string, conversationId: string): boolean {
    const ral = this.getState(agentPubkey, conversationId);
    if (!ral) return true;
    if (ral.isStreaming) return false;
    if (this.deps.getConversationCompletedDelegations(agentPubkey, conversationId, ral.ralNumber).length > 0) {
      return true;
    }
    if (this.deps.getConversationPendingDelegations(agentPubkey, conversationId, ral.ralNumber).length > 0) {
      return true;
    }
    return true;
  }

  clearAll(): void {
    this.states.clear();
    this.nextRalNumber.clear();
    this.ralIdToLocation.clear();
    this.abortControllers.clear();
  }

  hasOutstandingWork(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): {
    hasWork: boolean;
    details: { queuedInjections: number; pendingDelegations: number; completedDelegations: number };
  } {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    const pendingDelegations = this.deps.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber).length;
    const completedDelegations = this.deps.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber).length;

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
      return { hasWork, details: { queuedInjections: 0, pendingDelegations, completedDelegations } };
    }

    const queuedInjections = ral.queuedInjections.length;
    const hasWork = queuedInjections > 0 || pendingDelegations > 0 || completedDelegations > 0;
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

    return { hasWork, details: { queuedInjections, pendingDelegations, completedDelegations } };
  }

  getTotalActiveCount(): number {
    let totalCount = 0;
    for (const rals of this.states.values()) {
      totalCount += rals.size;
    }
    return totalCount;
  }

  getActiveRalsForConversation(conversationId: string): Array<{ agentPubkey: string; ralNumber: number }> {
    const results: Array<{ agentPubkey: string; ralNumber: number }> = [];
    for (const [key, rals] of this.states) {
      const [agentPubkey, convId] = key.split(":");
      if (convId === conversationId) {
        for (const ralNumber of rals.keys()) {
          results.push({ agentPubkey, ralNumber });
        }
      }
    }
    return results;
  }

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

  startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => this.cleanupExpiredStates(), RALStateRegistry.CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  cleanupExpiredStates(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, rals] of this.states.entries()) {
      for (const [ralNumber, state] of rals.entries()) {
        if (now - state.lastActivityAt > RALStateRegistry.STATE_TTL_MS) {
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

      if (rals.size === 0) {
        this.states.delete(key);
      }
    }

    const prunedKilledCount = this.deps.pruneKilledConversationKeys((key) => this.states.has(key));
    if (prunedKilledCount > 0) {
      logger.debug("[RALRegistry] Pruned stale killed agent entries", {
        prunedKilledCount,
        remainingKilledCount: this.deps.getKilledConversationCount(),
      });
    }

    if (cleanedCount > 0) {
      logger.info("[RALRegistry] Cleanup complete", {
        cleanedCount,
        remainingConversations: this.states.size,
      });
    }
  }
}
