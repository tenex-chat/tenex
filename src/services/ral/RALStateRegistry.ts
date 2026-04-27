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
  /**
   * Per-(agent, conversation) driver slot: which RAL is currently making LLM
   * calls. Distinct from per-RAL `isStreaming`, which only tracks "this RAL's
   * streamText is in flight". A RAL can be streaming but NOT the driver if it
   * has released the slot for a tool execution. At most one RAL per (agent,
   * conversation) holds the driver at any moment.
   */
  private readonly currentDriverByKey: Map<string, number> = new Map();
  /** One-shot listeners fired exactly once on the next driver release. */
  private readonly driverReleaseListenersByKey: Map<string, Array<() => void>> = new Map();
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

    // Driver slot follows the streamText lifecycle: acquired when streaming
    // starts, released when streaming ends. Tool-call boundaries within the
    // stream release/re-acquire the driver via a separate code path
    // (experimental_onToolCallStart / onStepFinish).
    if (isStreaming) {
      this.tryAcquireDriver(agentPubkey, conversationId, ralNumber);
    } else {
      this.releaseDriver(agentPubkey, conversationId, ralNumber);
    }

    const newState: "STREAMING" | "ACTING" | "REASONING" = isStreaming
      ? "STREAMING"
      : ral.activeTools.size > 0
        ? "ACTING"
        : "REASONING";

    llmOpsRegistry.updateRALState(agentPubkey, conversationId, newState);
    this.deps.emitUpdated(ral.projectId, conversationId);
  }

  /**
   * Returns which RAL currently holds the driver slot for this (agent,
   * conversation), or `undefined` if no RAL is driving (either idle or all
   * pending RALs are inside tool execution).
   */
  getDriver(agentPubkey: string, conversationId: string): number | undefined {
    return this.currentDriverByKey.get(this.makeKey(agentPubkey, conversationId));
  }

  /**
   * Atomically acquire the driver slot for `ralNumber`. Returns true if the
   * slot is now held by `ralNumber`. Idempotent: a RAL re-acquiring its own
   * slot returns true. Returns false if a different RAL holds the slot.
   *
   * Synchronous and atomic w.r.t. the JS event loop, so two concurrent
   * dispatchers calling this between awaits cannot both win.
   */
  tryAcquireDriver(agentPubkey: string, conversationId: string, ralNumber: number): boolean {
    const key = this.makeKey(agentPubkey, conversationId);
    const current = this.currentDriverByKey.get(key);
    if (current === undefined) {
      this.currentDriverByKey.set(key, ralNumber);
      return true;
    }
    return current === ralNumber;
  }

  /**
   * Release the driver slot if held by `ralNumber`. Fires any one-shot
   * listeners registered via `onceDriverReleased`. No-op if a different RAL
   * holds the slot or if the slot is already empty.
   */
  releaseDriver(agentPubkey: string, conversationId: string, ralNumber: number): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const current = this.currentDriverByKey.get(key);
    if (current !== ralNumber) return;
    this.currentDriverByKey.delete(key);

    const listeners = this.driverReleaseListenersByKey.get(key);
    if (listeners && listeners.length > 0) {
      this.driverReleaseListenersByKey.delete(key);
      for (const fn of listeners) {
        try {
          fn();
        } catch (e) {
          logger.error("[RALStateRegistry] driver-release listener threw", { error: e });
        }
      }
    }
  }

  /**
   * Register a one-shot listener that fires exactly once the next time the
   * driver slot for this (agent, conversation) transitions from held to
   * released. Used by deferred wakeups: a late-tool-result that lands while
   * a different RAL is driver registers here so the wakeup retries when the
   * current driver finishes.
   */
  onceDriverReleased(agentPubkey: string, conversationId: string, fn: () => void): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const existing = this.driverReleaseListenersByKey.get(key);
    if (existing) {
      existing.push(fn);
    } else {
      this.driverReleaseListenersByKey.set(key, [fn]);
    }
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
    // A streaming RAL with no driver is mid-tool (driver released for tool
    // execution). Resuming such a RAL would inject the user message into a
    // RAL that's about to be silently exited via lock-handoff. Refuse the
    // claim — the dispatcher should spawn a fresh concurrent RAL instead.
    if (ral.isStreaming) return undefined;
    if (this.getDriver(agentPubkey, conversationId) !== undefined) return undefined;
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
   * Synchronously create a fresh concurrent RAL and atomically reserve the
   * driver slot for it. Used by the dispatcher in the lock-handoff path: when
   * an existing RAL is mid-tool (driver released, isStreaming=true) and a
   * new user message arrives, the dispatcher spawns a concurrent RAL that
   * takes over driver duties.
   *
   * The check-create-claim block is fully synchronous, so two concurrent
   * dispatches calling this method between awaits cannot both succeed: the
   * first to run claims the driver slot, the second observes
   * `getDriver !== undefined` and returns `undefined`.
   *
   * Returns `undefined` if the driver slot is already held (race lost). The
   * caller should fall back to queueing the message and skipping execution.
   *
   * On success, the caller MUST pass the returned `ralNumber` and
   * `claimToken` to AgentExecutor via `preferredRalNumber` /
   * `preferredRalClaimToken`. The token will be handed off to the live
   * `isStreaming` flag inside `StreamExecutionHandler.execute()`.
   */
  tryCreateConcurrentRAL(
    agentPubkey: string,
    conversationId: string,
    projectId: ProjectDTag,
    triggeringEventId?: string,
    traceContext?: { traceId: string; spanId: string }
  ): { ralNumber: number; claimToken: string } | undefined {
    if (this.getDriver(agentPubkey, conversationId) !== undefined) return undefined;

    const ralNumber = this.create(
      agentPubkey,
      conversationId,
      projectId,
      triggeringEventId,
      traceContext,
    );

    // Driver is unheld (verified above) and no awaits separate that check
    // from this acquire — the JS event loop guarantees atomicity, so this
    // always succeeds. The non-null assertion below mirrors that invariant.
    this.tryAcquireDriver(agentPubkey, conversationId, ralNumber);

    const ral = this.getRAL(agentPubkey, conversationId, ralNumber)!;
    const claimToken = crypto.randomUUID();
    ral.executionClaimToken = claimToken;
    ral.lastActivityAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.concurrent_ral_created", {
      "ral.number": ralNumber,
      "ral.id": ral.id,
      "claim.token": claimToken,
      "agent.pubkey": shortenPubkey(agentPubkey),
      "conversation.id": shortenConversationId(conversationId),
    });

    return { ralNumber, claimToken };
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

  /**
   * Mark a tool as starting execution within `ralNumber`'s current step.
   *
   * Side-effect: releases the driver slot if `ralNumber` currently holds it,
   * so that a user message arriving while this tool runs can spawn a fresh
   * concurrent RAL via `tryAcquireDriver`. Idempotent across parallel-tool
   * starts in the same step (the second start finds driver already null and
   * is a no-op).
   */
  startTool(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    toolCallId: string,
    toolName: string
  ): void {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return;

    const now = Date.now();
    ral.activeTools.set(toolCallId, { name: toolName, startedAt: now });
    ral.toolStartedAt = now;
    ral.currentTool = toolName;
    ral.lastActivityAt = now;

    // Release the driver slot for the duration of the tool execution. If
    // another RAL is already driver (shouldn't happen at start-of-tool from
    // a healthy stream), this is a no-op.
    if (this.currentDriverByKey.get(this.makeKey(agentPubkey, conversationId)) === ralNumber) {
      this.releaseDriver(agentPubkey, conversationId, ralNumber);
    }

    const newState: "ACTING" | "STREAMING" | "REASONING" =
      ral.activeTools.size > 0 ? "ACTING" : ral.isStreaming ? "STREAMING" : "REASONING";
    llmOpsRegistry.updateRALState(agentPubkey, conversationId, newState);
    this.deps.emitUpdated(ral.projectId, conversationId);

    trace.getActiveSpan()?.addEvent("ral.tool_started", {
      "ral.number": ralNumber,
      "tool.call_id": toolCallId,
      "tool.name": toolName,
      "ral.active_tools_count": ral.activeTools.size,
    });
  }

  /**
   * Mark a tool as finished within `ralNumber`. Returns the resulting
   * lock-handoff state:
   *
   * - `"still-pending"` — `ralNumber` still has other tools in flight (parallel
   *   tools); caller waits for siblings to finish before deciding.
   * - `"reacquired"` — all of `ralNumber`'s tools have finished and the driver
   *   slot is now held by `ralNumber` again. Caller continues normally.
   * - `"preempted"` — all of `ralNumber`'s tools have finished, but a different
   *   RAL holds the driver slot. Caller should silently exit and surface the
   *   tool result via a late-tool-result entry.
   */
  finishTool(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    toolCallId: string
  ): "still-pending" | "reacquired" | "preempted" {
    const ral = this.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) return "preempted";

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
    ral.lastActivityAt = Date.now();

    let outcome: "still-pending" | "reacquired" | "preempted";
    if (ral.activeTools.size > 0) {
      outcome = "still-pending";
    } else {
      outcome = this.tryAcquireDriver(agentPubkey, conversationId, ralNumber)
        ? "reacquired"
        : "preempted";
    }

    const newState: "ACTING" | "STREAMING" | "REASONING" =
      ral.activeTools.size > 0 ? "ACTING" : ral.isStreaming ? "STREAMING" : "REASONING";
    llmOpsRegistry.updateRALState(agentPubkey, conversationId, newState);
    this.deps.emitUpdated(ral.projectId, conversationId);

    trace.getActiveSpan()?.addEvent("ral.tool_completed", {
      "ral.number": ralNumber,
      "tool.call_id": toolCallId,
      "ral.active_tools_count": ral.activeTools.size,
      "ral.tool_outcome": outcome,
    });

    return outcome;
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

    // Release the driver slot if this RAL was holding it. Fires any
    // listeners waiting on the next driver release.
    if (this.currentDriverByKey.get(key) === ralNumber) {
      this.releaseDriver(agentPubkey, conversationId, ralNumber);
    }

    if (rals.size === 0) {
      this.states.delete(key);
      this.driverReleaseListenersByKey.delete(key);
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
    if (this.getDriver(agentPubkey, conversationId) !== undefined) return false;
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
    this.currentDriverByKey.clear();
    this.driverReleaseListenersByKey.clear();
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
