import { trace } from "@opentelemetry/api";
import { EventEmitter, type DefaultEventMap } from "tseep";
import { INJECTION_ABORT_REASON, llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import type { ProjectDTag } from "@/types/project-ids";
import { logger } from "@/utils/logger";
import type {
  CompletedDelegation,
  DelegationMessage,
  InjectionResult,
  InjectionRole,
  PendingDelegation,
  QueuedInjection,
  RALRegistryEntry,
} from "./types";
import { DelegationRegistry } from "./DelegationRegistry";
import { ExecutionTimingTracker } from "./ExecutionTimingTracker";
import { HeuristicViolationManager } from "./HeuristicViolationManager";
import { KillSwitchRegistry } from "./KillSwitchRegistry";
import { MessageInjectionQueue } from "./MessageInjectionQueue";
import { RALStateRegistry } from "./RALStateRegistry";

export type RALRegistryEvents = DefaultEventMap & {
  updated: (...args: [projectId: ProjectDTag, conversationId: string]) => void;
};

export class RALRegistry extends EventEmitter<RALRegistryEvents> {
  private static instance: RALRegistry;
  private static readonly MAX_QUEUE_SIZE = 100;

  private readonly stateRegistry: RALStateRegistry;
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
    const killSwitchRegistryHolder: { current: KillSwitchRegistry | null } = { current: null };
    const getKillSwitchRegistry = (): KillSwitchRegistry => {
      if (!killSwitchRegistryHolder.current) {
        throw new Error("[RALRegistry] KillSwitchRegistry not initialized.");
      }
      return killSwitchRegistryHolder.current;
    };
    this.stateRegistry = new RALStateRegistry({
      emitUpdated: this.emitUpdated.bind(this),
      getConversationPendingDelegations: this.getConversationPendingDelegations.bind(this),
      getConversationCompletedDelegations: this.getConversationCompletedDelegations.bind(this),
      pruneKilledConversationKeys: (hasState) => getKillSwitchRegistry().pruneStaleKilledConversations(hasState),
      getKilledConversationCount: () => getKillSwitchRegistry().getKilledConversationCount(),
    });
    this.delegationRegistry = new DelegationRegistry({
      getRAL: this.stateRegistry.getRAL.bind(this.stateRegistry),
      incrementDelegationCounter: this.incrementDelegationCounter.bind(this),
      decrementDelegationCounter: this.decrementDelegationCounter.bind(this),
    });
    killSwitchRegistryHolder.current = new KillSwitchRegistry(
      {
        getState: this.stateRegistry.getState.bind(this.stateRegistry),
        getActiveRALs: this.stateRegistry.getActiveRALs.bind(this.stateRegistry),
        getAbortControllers: () => this.stateRegistry.getAbortControllers(),
        clearConversation: (agentPubkey, conversationId) => {
          this.stateRegistry.clear(agentPubkey, conversationId);
          this.delegationRegistry.clearConversation(agentPubkey, conversationId);
          getKillSwitchRegistry().clearConversation(agentPubkey, conversationId);
        },
        makeKey: this.stateRegistry.makeKey.bind(this.stateRegistry),
        makeAbortKey: this.stateRegistry.makeAbortKey.bind(this.stateRegistry),
      },
      this.delegationRegistry
    );
    this.killSwitchRegistry = getKillSwitchRegistry();
    this.startCleanupInterval();
  }

  static getInstance(): RALRegistry {
    if (!RALRegistry.instance) RALRegistry.instance = new RALRegistry();
    return RALRegistry.instance;
  }

  private emitUpdated(projectId: ProjectDTag, conversationId: string): void {
    this.emit("updated", projectId, conversationId);
  }

  get conversationDelegations(): Map<string, { pending: Map<string, PendingDelegation>; completed: Map<string, CompletedDelegation> }> {
    return this.delegationRegistry.conversationDelegationsMap;
  }

  get delegationToRal(): Map<string, { key: string; ralNumber: number }> {
    return this.delegationRegistry.delegationToRalMap;
  }

  get followupToCanonical(): Map<string, string> {
    return this.delegationRegistry.followupToCanonicalMap;
  }

  get killedAgentConversations(): Set<string> {
    return this.killSwitchRegistry.killedAgentConversationsSet;
  }

  get states(): Map<string, Map<number, RALRegistryEntry>> {
    return this.stateRegistry.statesMap;
  }

  get nextRalNumber(): Map<string, number> {
    return this.stateRegistry.nextRalNumberMap;
  }

  get ralIdToLocation(): Map<string, { key: string; ralNumber: number }> {
    return this.stateRegistry.ralIdToLocationMap;
  }

  get abortControllers(): Map<string, AbortController> {
    return this.stateRegistry.abortControllersMap;
  }

  private startCleanupInterval(): void {
    this.cleanupExpiredStates();
  }

  private cleanupExpiredStates(): void {
    this.stateRegistry.cleanupExpiredStates();
  }

  create(agentPubkey: string, conversationId: string, projectId: ProjectDTag, originalTriggeringEventId?: string, traceContext?: { traceId: string; spanId: string }): number {
    return this.stateRegistry.create(agentPubkey, conversationId, projectId, originalTriggeringEventId, traceContext);
  }
  getActiveRALs(agentPubkey: string, conversationId: string): RALRegistryEntry[] { return this.stateRegistry.getActiveRALs(agentPubkey, conversationId); }
  getRAL(agentPubkey: string, conversationId: string, ralNumber: number): RALRegistryEntry | undefined { return this.stateRegistry.getRAL(agentPubkey, conversationId, ralNumber); }
  getStateByRalId(ralId: string): RALRegistryEntry | undefined { return this.stateRegistry.getStateByRalId(ralId); }
  getState(agentPubkey: string, conversationId: string): RALRegistryEntry | undefined { return this.stateRegistry.getState(agentPubkey, conversationId); }
  getConversationEntries(conversationId: string): RALRegistryEntry[] { return this.stateRegistry.getConversationEntries(conversationId); }
  getConversationPendingDelegations(agentPubkey: string, conversationId: string, ralNumber?: number): PendingDelegation[] { return this.delegationRegistry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber); }
  getConversationCompletedDelegations(agentPubkey: string, conversationId: string, ralNumber?: number): CompletedDelegation[] { return this.delegationRegistry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber); }
  setStreaming(agentPubkey: string, conversationId: string, ralNumber: number, isStreaming: boolean): void { this.stateRegistry.setStreaming(agentPubkey, conversationId, ralNumber, isStreaming); }
  requestSilentCompletion(agentPubkey: string, conversationId: string, ralNumber: number): boolean { return this.stateRegistry.requestSilentCompletion(agentPubkey, conversationId, ralNumber); }
  isSilentCompletionRequested(agentPubkey: string, conversationId: string, ralNumber: number): boolean { return this.stateRegistry.isSilentCompletionRequested(agentPubkey, conversationId, ralNumber); }
  clearSilentCompletionRequest(agentPubkey: string, conversationId: string, ralNumber: number): boolean { return this.stateRegistry.clearSilentCompletionRequest(agentPubkey, conversationId, ralNumber); }

  startLLMStream(agentPubkey: string, conversationId: string, ralNumber: number, lastUserMessage?: string): void {
    this.timingTracker.startLLMStream(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber, lastUserMessage);
  }
  endLLMStream(agentPubkey: string, conversationId: string, ralNumber: number): number { return this.timingTracker.endLLMStream(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber); }
  getAccumulatedRuntime(agentPubkey: string, conversationId: string, ralNumber: number): number { return this.timingTracker.getAccumulatedRuntime(this.getRAL(agentPubkey, conversationId, ralNumber)); }
  consumeUnreportedRuntime(agentPubkey: string, conversationId: string, ralNumber: number): number { return this.timingTracker.consumeUnreportedRuntime(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber); }
  getUnreportedRuntime(agentPubkey: string, conversationId: string, ralNumber: number): number { return this.timingTracker.getUnreportedRuntime(this.getRAL(agentPubkey, conversationId, ralNumber)); }

  setPendingDelegations(agentPubkey: string, conversationId: string, ralNumber: number, pendingDelegations: PendingDelegation[]): void { this.delegationRegistry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations); }
  mergePendingDelegations(agentPubkey: string, conversationId: string, ralNumber: number, newDelegations: PendingDelegation[]): { insertedCount: number; mergedCount: number } { return this.delegationRegistry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, newDelegations); }
  recordCompletion(completion: { delegationConversationId: string; recipientPubkey: string; response: string; completedAt: number; fullTranscript?: DelegationMessage[] }): { agentPubkey: string; conversationId: string; ralNumber: number } | undefined { return this.delegationRegistry.recordCompletion(completion); }
  clearCompletedDelegations(agentPubkey: string, conversationId: string, ralNumber?: number): void { this.delegationRegistry.clearCompletedDelegations(agentPubkey, conversationId, ralNumber); }

  injectMessage(params: { agentPubkey: string; conversationId: string; message: string; role?: InjectionRole }): InjectionResult {
    const { agentPubkey, conversationId, message, role = "user" } = params;
    const activeRal = this.getState(agentPubkey, conversationId);
    if (!activeRal) return { queued: false, aborted: false };
    this.injectionQueue.queueMessage(activeRal, agentPubkey, conversationId, activeRal.ralNumber, role, message);
    const messageLength = message.length;
    let aborted = false;
    if (activeRal.isStreaming) {
      aborted = llmOpsRegistry.stopByAgentAndConversation(agentPubkey, conversationId, INJECTION_ABORT_REASON);
      trace.getActiveSpan()?.addEvent("ral.injection_streaming", { "ral.id": activeRal.id, "ral.number": activeRal.ralNumber, "injection.length": messageLength, aborted });
      if (aborted) {
        logger.info("[RALRegistry] Aborted streaming execution for injection", { agentPubkey: agentPubkey.substring(0, 8), conversationId: conversationId.substring(0, 8), ralNumber: activeRal.ralNumber, injectionLength: messageLength });
      }
    }
    trace.getActiveSpan()?.addEvent("ral.injection_queued", { "ral.id": activeRal.id, "ral.number": activeRal.ralNumber, "injection.role": role, "injection.length": messageLength, "ral.is_streaming": activeRal.isStreaming });
    return { activeRal, queued: true, aborted };
  }
  queueSystemMessage(agentPubkey: string, conversationId: string, ralNumber: number, message: string): void { this.injectionQueue.queueSystemMessage(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber, message); }
  queueUserMessage(agentPubkey: string, conversationId: string, ralNumber: number, message: string, options?: { senderPubkey?: string; senderPrincipal?: QueuedInjection["senderPrincipal"]; targetedPrincipals?: QueuedInjection["targetedPrincipals"]; eventId?: string }): void { this.injectionQueue.queueUserMessage(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber, message, options); }
  getAndConsumeInjections(agentPubkey: string, conversationId: string, ralNumber: number): QueuedInjection[] { return this.injectionQueue.getAndConsumeInjections(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber); }
  clearQueuedInjectionByEventId(agentPubkey: string, conversationId: string, eventId: string): number { return this.injectionQueue.clearQueuedInjectionByEventId(this.stateRegistry.getActiveRALs(agentPubkey, conversationId).values(), agentPubkey, conversationId, eventId); }
  clearQueuedInjections(agentPubkey: string, conversationId: string): void { this.injectionQueue.clearQueuedInjections(this.stateRegistry.getActiveRALs(agentPubkey, conversationId).values(), agentPubkey, conversationId); }

  setToolActive(agentPubkey: string, conversationId: string, ralNumber: number, toolCallId: string, isActive: boolean, toolName?: string): void { this.stateRegistry.setToolActive(agentPubkey, conversationId, ralNumber, toolCallId, isActive, toolName); }
  clearToolFallback(agentPubkey: string, conversationId: string, ralNumber: number, toolCallId: string): boolean { return this.stateRegistry.clearToolFallback(agentPubkey, conversationId, ralNumber, toolCallId); }
  registerAbortController(agentPubkey: string, conversationId: string, ralNumber: number, controller: AbortController): void { this.stateRegistry.registerAbortController(agentPubkey, conversationId, ralNumber, controller); }
  clearRAL(agentPubkey: string, conversationId: string, ralNumber: number): void { this.stateRegistry.clearRAL(agentPubkey, conversationId, ralNumber); }
  clear(agentPubkey: string, conversationId: string): void { this.stateRegistry.clear(agentPubkey, conversationId); this.killSwitchRegistry.clearConversation(agentPubkey, conversationId); this.delegationRegistry.clearConversation(agentPubkey, conversationId); }

  resolveDelegationPrefix(prefix: string): string | null { return this.delegationRegistry.resolveDelegationPrefix(prefix); }
  canonicalizeDelegationId(id: string): string { return this.delegationRegistry.canonicalizeDelegationId(id); }
  findDelegation(delegationEventId: string): { pending?: PendingDelegation; completed?: CompletedDelegation; agentPubkey: string; conversationId: string; ralNumber: number } | undefined { return this.delegationRegistry.findDelegation(delegationEventId); }
  findStateWaitingForDelegation(delegationEventId: string): RALRegistryEntry | undefined { return this.delegationRegistry.findStateWaitingForDelegation(delegationEventId); }
  getRalKeyForDelegation(delegationEventId: string): string | undefined { return this.delegationRegistry.getRalKeyForDelegation(delegationEventId); }
  findResumableRAL(agentPubkey: string, conversationId: string): RALRegistryEntry | undefined { return this.stateRegistry.findResumableRAL(agentPubkey, conversationId); }
  findRALWithInjections(agentPubkey: string, conversationId: string): RALRegistryEntry | undefined { return this.stateRegistry.findRALWithInjections(agentPubkey, conversationId); }
  shouldWakeUpExecution(agentPubkey: string, conversationId: string): boolean { return this.stateRegistry.shouldWakeUpExecution(agentPubkey, conversationId); }

  abortCurrentTool(agentPubkey: string, conversationId: string): void { this.killSwitchRegistry.abortCurrentTool(agentPubkey, conversationId); }
  abortAllForAgent(agentPubkey: string, conversationId: string): number { return this.killSwitchRegistry.abortAllForAgent(agentPubkey, conversationId); }
  async abortWithCascade(agentPubkey: string, conversationId: string, projectId: ProjectDTag, reason: string, cooldownRegistry?: { add: (projectId: ProjectDTag, convId: string, agentPubkey: string, reason: string) => void }): Promise<{ abortedCount: number; descendantConversations: Array<{ conversationId: string; agentPubkey: string }> }> { return this.killSwitchRegistry.abortWithCascade(agentPubkey, conversationId, projectId, reason, cooldownRegistry); }
  clearAll(): void { this.stateRegistry.clearAll(); this.delegationRegistry.clearAll(); this.killSwitchRegistry.clearAll(); }

  markDelegationKilled(delegationConversationId: string): boolean { return this.killSwitchRegistry.markDelegationKilled(delegationConversationId); }
  isDelegationKilled(delegationConversationId: string): boolean { return this.killSwitchRegistry.isDelegationKilled(delegationConversationId); }
  markAllDelegationsKilled(agentPubkey: string, conversationId: string): number { return this.killSwitchRegistry.markAllDelegationsKilled(agentPubkey, conversationId); }
  markAgentConversationKilled(agentPubkey: string, conversationId: string): void { this.killSwitchRegistry.markAgentConversationKilled(agentPubkey, conversationId); }
  isAgentConversationKilled(agentPubkey: string, conversationId: string): boolean { return this.killSwitchRegistry.isAgentConversationKilled(agentPubkey, conversationId); }
  getDelegationRecipientPubkey(delegationConversationId: string): string | null { return this.killSwitchRegistry.getDelegationRecipientPubkey(delegationConversationId); }
  markParentDelegationKilled(delegationConversationId: string): boolean { return this.killSwitchRegistry.markParentDelegationKilled(delegationConversationId); }

  addHeuristicViolations(agentPubkey: string, conversationId: string, ralNumber: number, violations: Array<{ id: string; title: string; message: string; severity: "warning" | "error"; timestamp: number; heuristicId: string }>): void { this.heuristicManager.addHeuristicViolations(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber, violations); }
  getAndConsumeHeuristicViolations(agentPubkey: string, conversationId: string, ralNumber: number): Array<{ id: string; title: string; message: string; severity: "warning" | "error"; timestamp: number; heuristicId: string }> { return this.heuristicManager.getAndConsumeHeuristicViolations(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber); }
  hasPendingHeuristicViolations(agentPubkey: string, conversationId: string, ralNumber: number): boolean { return this.heuristicManager.hasPendingHeuristicViolations(this.getRAL(agentPubkey, conversationId, ralNumber)); }
  storeToolArgs(agentPubkey: string, conversationId: string, ralNumber: number, toolCallId: string, args: unknown): void { this.heuristicManager.storeToolArgs(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber, toolCallId, args); }
  getToolArgs(agentPubkey: string, conversationId: string, ralNumber: number, toolCallId: string): unknown | undefined { return this.heuristicManager.getToolArgs(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber, toolCallId); }
  clearToolArgs(agentPubkey: string, conversationId: string, ralNumber: number, toolCallId: string): void { this.heuristicManager.clearToolArgs(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber, toolCallId); }
  updateHeuristicSummary(agentPubkey: string, conversationId: string, ralNumber: number, toolName: string, toolArgs: unknown, maxRecentTools = 10): void { this.heuristicManager.updateHeuristicSummary(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber, toolName, toolArgs, maxRecentTools); }
  private incrementDelegationCounter(agentPubkey: string, conversationId: string, ralNumber: number): void { this.heuristicManager.incrementDelegationCounter(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber); }
  private decrementDelegationCounter(agentPubkey: string, conversationId: string, ralNumber: number): void { this.heuristicManager.decrementDelegationCounter(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber); }
  getHeuristicSummary(agentPubkey: string, conversationId: string, ralNumber: number): { recentTools: Array<{ name: string; timestamp: number }>; flags: { hasTodoWrite: boolean; hasDelegation: boolean; hasVerification: boolean; hasGitAgentCommit: boolean }; pendingDelegationCount: number } | undefined { return this.heuristicManager.getHeuristicSummary(this.getRAL(agentPubkey, conversationId, ralNumber), agentPubkey, conversationId, ralNumber); }

  hasOutstandingWork(agentPubkey: string, conversationId: string, ralNumber: number): { hasWork: boolean; details: { queuedInjections: number; pendingDelegations: number; completedDelegations: number } } { return this.stateRegistry.hasOutstandingWork(agentPubkey, conversationId, ralNumber); }
  getTotalActiveCount(): number { return this.stateRegistry.getTotalActiveCount(); }
  getActiveRalsForConversation(conversationId: string): Array<{ agentPubkey: string; ralNumber: number }> { return this.stateRegistry.getActiveRalsForConversation(conversationId); }
  getActiveEntriesForProject(projectId: ProjectDTag): RALRegistryEntry[] { return this.stateRegistry.getActiveEntriesForProject(projectId); }
}
