import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { createExecutionContext } from "@/agents/execution/ExecutionContextFactory";
import {
    executeDispatchViaAgentWorker,
    getAgentWorkerDispatchIneligibility,
    isAgentWorkerDispatchEnabled,
} from "@/agents/execution/worker/dispatch-adapter";
import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { ConversationResolver } from "@/conversations/services/ConversationResolver";
import { ConversationSummarizer } from "@/conversations/services/ConversationSummarizer";
import { metadataDebounceManager } from "@/conversations/services/MetadataDebounceManager";
import type { DelegationMarker, MessagePrincipalContext, PrincipalSnapshot } from "@/conversations/types";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import {
    getMentionedPubkeys,
    getReplyTarget,
    isAgentInternalMessage,
    isDelegationCompletion,
    isDirectedToSystem,
    isFromAgent,
} from "@/events/runtime/envelope-classifier";
import { formatAnyError } from "@/lib/error-formatter";
import { shortenConversationId, shortenPubkey } from "@/utils/conversation-id";
import { config } from "@/services/ConfigService";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { getProjectContext, type ProjectContext } from "@/services/projects";
import { CooldownRegistry } from "@/services/CooldownRegistry";
import { RALRegistry } from "@/services/ral";
import type { RALRegistryEntry } from "@/services/ral/types";
import { logger } from "@/utils/logger";
import { ROOT_CONTEXT, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import { AgentRouter } from "@/services/dispatch/AgentRouter";
import {
    handleDelegationCompletion,
    type DelegationCompletionResult,
} from "@/services/dispatch/DelegationCompletionHandler";
import { projectRuntimeRegistry } from "@/services/runtime/ProjectRuntimeRegistryService";

const tracer = trace.getTracer("tenex.dispatch");
const DELEGATION_COMPLETION_DEBOUNCE_MS = 2500;
const LIVE_INJECTION_TIMEOUT_MS = 2000;

const getSafeContext = (): ReturnType<typeof otelContext.active> => {
    const activeContext = otelContext.active();
    return typeof (activeContext as { getValue?: unknown }).getValue === "function"
        ? activeContext
        : ROOT_CONTEXT;
};

const getSafeActiveSpan = (): ReturnType<typeof trace.getActiveSpan> => {
    try {
        return trace.getActiveSpan();
    } catch {
        return undefined;
    }
};

interface DispatchContext {
    agentExecutor: AgentExecutor;
}

interface DelegationTarget {
    agent: AgentInstance;
    conversationId: string;
}

/**
 * Outcome of `handleDeliveryInjection`. Carries both the skip decision and,
 * when applicable, the resumption claim that the dispatcher must eventually
 * release in its own `finally` block (see `dispatchToAgent`).
 */
interface DeliveryInjectionResult {
    skipExecution: boolean;
    claim?: {
        ralNumber: number;
        token: string;
    };
}

export class AgentDispatchService {
    private static instance: AgentDispatchService;
    private readonly delegationDebounceState = new Map<
        string,
        { timeout: ReturnType<typeof setTimeout>; promise: Promise<void>; resolve: () => void }
    >();
    private readonly delegationDebounceSequence = new Map<string, number>();

    private constructor() {}

    static getInstance(): AgentDispatchService {
        if (!AgentDispatchService.instance) {
            AgentDispatchService.instance = new AgentDispatchService();
        }
        return AgentDispatchService.instance;
    }

    /**
     * Wake up the parent agent of a killed delegation.
     *
     * Builds a synthetic local-only kill-signal envelope and routes it through
     * handleDelegationCompletion's implicit-kill branch, which resolves the parent
     * agent without touching any transport metadata paths.
     *
     * No-ops silently when no parent is found (top-level kill) or the target was
     * already consumed (first-terminal-state-wins race condition).
     */
    async dispatchKillWakeup(delegationConversationId: string, agentExecutor: AgentExecutor): Promise<void> {
        const syntheticEnvelope: InboundEnvelope = {
            transport: "local",
            principal: {
                id: "kill-signal",
                transport: "local",
                kind: "system",
            },
            channel: {
                id: delegationConversationId,
                transport: "local",
                kind: "conversation",
            },
            message: {
                id: `kill-wakeup:${delegationConversationId}`,
                transport: "local",
                nativeId: `kill-wakeup:${delegationConversationId}`,
            },
            recipients: [],
            content: "",
            occurredAt: Math.floor(Date.now() / 1000),
            capabilities: [],
            metadata: {
                isKillSignal: true,
                killSignalDelegationConversationId: delegationConversationId,
            },
        };

        const result = await handleDelegationCompletion(syntheticEnvelope);
        await this.handleKillWakeup(syntheticEnvelope, result, agentExecutor);
    }

    private async handleKillWakeup(
        envelope: InboundEnvelope,
        result: DelegationCompletionResult,
        agentExecutor: AgentExecutor
    ): Promise<void> {
        if (!result.recorded) {
            logger.debug("[AgentDispatchService] Kill wake-up: no parent agent to resume (consumed or not found)", {
                delegationConversationId: shortenConversationId(
                    envelope.metadata.killSignalDelegationConversationId ?? ""
                ),
            });
            return;
        }

        const parentProjectId = result.conversationId
            ? ConversationStore.get(result.conversationId)?.getProjectId()
            : undefined;
        const parentRuntime = projectRuntimeRegistry.get(parentProjectId);

        if (parentRuntime) {
            await projectRuntimeRegistry.runInProjectContext(parentRuntime, async () => {
                await this.routeKillWakeup(envelope, result, parentRuntime.agentExecutor, parentRuntime.projectContext);
            });
            return;
        }

        const projectCtx = getProjectContext();
        await this.routeKillWakeup(envelope, result, agentExecutor, projectCtx);
    }

    private async routeKillWakeup(
        envelope: InboundEnvelope,
        result: DelegationCompletionResult,
        agentExecutor: AgentExecutor,
        projectCtx: ProjectContext
    ): Promise<void> {
        const delegationTarget = AgentRouter.resolveDelegationTarget(result, projectCtx);

        if (!delegationTarget) {
            logger.warn("[AgentDispatchService] Kill wake-up: could not resolve delegation target (agent config missing?)", {
                agentSlug: result.agentSlug,
                agentPubkey: result.agentPubkey ? shortenPubkey(result.agentPubkey) : undefined,
                conversationId: result.conversationId ? shortenConversationId(result.conversationId) : undefined,
            });
            return;
        }

        const span = tracer.startSpan("tenex.dispatch.kill_wakeup", {
            attributes: {
                "delegation.agent_slug": delegationTarget.agent.slug,
                "delegation.conversation_id": shortenConversationId(delegationTarget.conversationId),
            },
        }, getSafeContext());

        try {
            await this.handleDelegationResponse(envelope, delegationTarget, agentExecutor, projectCtx, span);
            span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
            logger.error("[AgentDispatchService] Kill wake-up: delegation response handling failed", {
                agentSlug: delegationTarget.agent.slug,
                conversationId: shortenConversationId(delegationTarget.conversationId),
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            span.end();
        }
    }

    async dispatch(envelope: InboundEnvelope, context: DispatchContext): Promise<void> {
        const senderId = envelope.principal.linkedPubkey ?? envelope.principal.id;
        const telegramMetadata = envelope.metadata.transport?.telegram;
        const span = tracer.startSpan(
            "tenex.dispatch.chat_message",
            {
                attributes: {
                    "event.id": envelope.message.nativeId,
                    "event.pubkey": senderId,
                    "event.kind": envelope.metadata.eventKind ?? 0,
                    "event.content_length": envelope.content.length,
                    "runtime.transport": envelope.transport,
                    "telegram.update.id": telegramMetadata?.updateId ?? 0,
                    "telegram.chat.id": telegramMetadata?.chatId ?? "",
                    "telegram.message.id": telegramMetadata?.messageId ?? "",
                    "telegram.chat.thread_id": telegramMetadata?.threadId ?? "",
                    "telegram.sender.id": telegramMetadata?.senderUserId ?? "",
                },
            },
            getSafeContext()
        );

        try {
            await this.handleChatMessage(envelope, context, span);
            span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
            span.recordException(error as Error);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (error as Error).message,
            });
            logger.error("Failed to route reply", {
                error: formatAnyError(error),
                eventId: envelope.message.nativeId,
            });
            logger.writeToWarnLog({
                timestamp: new Date().toISOString(),
                level: "error",
                component: "AgentDispatchService",
                message: "Failed to route incoming reply",
                context: {
                    eventId: envelope.message.nativeId,
                    eventKind: envelope.metadata.eventKind,
                    pubkey: senderId,
                },
                error: formatAnyError(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
        } finally {
            span.end();
        }
    }

    private async handleChatMessage(
        envelope: InboundEnvelope,
        { agentExecutor }: DispatchContext,
        span: ReturnType<typeof tracer.startSpan>
    ): Promise<void> {
        const projectCtx = getProjectContext();
        const principalContext = this.toMessagePrincipalContext(envelope);
        const senderId = envelope.principal.linkedPubkey ?? envelope.principal.id;

        const directedToSystem = isDirectedToSystem(
            envelope,
            projectCtx.agents,
            projectCtx.projectManager?.pubkey
        );
        const authoredByAgent = isFromAgent(envelope, projectCtx.agents);

        span.setAttributes({
            "routing.is_directed_to_system": directedToSystem,
            "routing.is_from_agent": authoredByAgent,
        });

        getSafeActiveSpan()?.addEvent("reply.message_received", {
            "event.id": envelope.message.nativeId,
            "event.pubkey": senderId.substring(0, 8),
            "message.preview": envelope.content.substring(0, 100),
            "routing.is_directed_to_system": directedToSystem,
            "routing.is_from_agent": authoredByAgent,
        });

        span.addEvent("dispatch.message_received", {
            "routing.is_directed_to_system": directedToSystem,
            "routing.is_from_agent": authoredByAgent,
        });

        if (!directedToSystem && authoredByAgent) {
            getSafeActiveSpan()?.addEvent("reply.agent_event_not_directed", {
                "event.id": envelope.message.nativeId,
            });
            span.addEvent("dispatch.agent_event_not_directed");

            const resolver = new ConversationResolver();
            const result = await resolver.resolveConversationForEvent(envelope, principalContext);

            if (result.conversation) {
                await ConversationStore.addEnvelope(result.conversation.id, envelope, principalContext);
                getSafeActiveSpan()?.addEvent("reply.added_to_history", {
                    "conversation.id": shortenConversationId(result.conversation.id),
                });
                span.addEvent("dispatch.agent_event_added_to_history", {
                    "conversation.id": shortenConversationId(result.conversation.id),
                });
            } else {
                logger.warn("[AgentDispatchService] No conversation found for agent-authored event", {
                    eventId: envelope.message.nativeId,
                    replyTarget: getReplyTarget(envelope),
                    projectBinding: envelope.channel.projectBinding,
                });
                getSafeActiveSpan()?.addEvent("reply.no_conversation_found", {
                    "event.id": envelope.message.nativeId,
                });
                span.addEvent("dispatch.agent_event_no_conversation");
            }
            return;
        }

        await this.handleReplyLogic(envelope, agentExecutor, projectCtx, span, principalContext);
    }

    private async handleReplyLogic(
        envelope: InboundEnvelope,
        agentExecutor: AgentExecutor,
        projectCtx: ProjectContext,
        span: ReturnType<typeof tracer.startSpan>,
        principalContext?: MessagePrincipalContext
    ): Promise<void> {
        const delegationResult = await handleDelegationCompletion(envelope);
        const senderPubkey = envelope.principal.linkedPubkey;

        if (delegationResult.deferred) {
            const activeSpan = getSafeActiveSpan();
            activeSpan?.addEvent("reply.delegation_completion_deferred", {
                "event.id": envelope.message.nativeId,
                "event.pubkey": senderPubkey?.substring(0, 8) ?? "",
            });
            span.addEvent("dispatch.delegation_completion_deferred", {
                "event.id": envelope.message.nativeId,
            });
            return;
        }

        const delegationTarget = AgentRouter.resolveDelegationTarget(delegationResult, projectCtx);

        if (delegationTarget) {
            span.addEvent("dispatch.delegation_completion_routed", {
                "delegation.agent_slug": delegationTarget.agent.slug,
                "delegation.conversation_id": shortenConversationId(delegationTarget.conversationId),
            });
            await this.handleDelegationResponse(envelope, delegationTarget, agentExecutor, projectCtx, span);
            return;
        }

        if (isDelegationCompletion(envelope)) {
            const activeSpan = getSafeActiveSpan();
            activeSpan?.addEvent("reply.completion_dropped_no_waiting_ral", {
                "event.id": envelope.message.nativeId,
                "event.pubkey": senderPubkey?.substring(0, 8) ?? "",
            });
            activeSpan?.setStatus({
                code: SpanStatusCode.ERROR,
                message: "Delegation completion dropped: no waiting RAL found. This indicates a delegation registration bug.",
            });
            logger.error("[reply] Delegation completion dropped - no waiting RAL", {
                eventId: envelope.message.nativeId,
                eventPubkey: senderPubkey?.substring(0, 8),
            });
            span.addEvent("dispatch.delegation_completion_dropped");
            return;
        }

        const conversationResolver = new ConversationResolver();
        const { conversation, isNew } = await conversationResolver.resolveConversationForEvent(
            envelope,
            principalContext
        );

        if (!conversation) {
            logger.error("No conversation found or created for event", {
                eventId: envelope.message.nativeId,
                replyTarget: getReplyTarget(envelope),
            });
            span.addEvent("dispatch.conversation_missing", {
                "event.id": envelope.message.nativeId,
            });
            return;
        }

        span.setAttributes({
            "conversation.id": shortenConversationId(conversation.id),
            "conversation.is_new": isNew,
        });

        if (!isNew && conversation.hasEventId(envelope.message.nativeId)) {
            getSafeActiveSpan()?.addEvent("reply.skipped_duplicate_event", {
                "event.id": envelope.message.nativeId,
                "conversation.id": shortenConversationId(conversation.id),
            });
            span.addEvent("dispatch.duplicate_event_skipped", {
                "conversation.id": shortenConversationId(conversation.id),
            });

            if (!isAgentInternalMessage(envelope)) {
                await ConversationStore.addEnvelope(conversation.id, envelope, principalContext);
            }
            return;
        }

        if (!isNew && !isAgentInternalMessage(envelope)) {
            await ConversationStore.addEnvelope(conversation.id, envelope, principalContext);
        }

        if (isNew && !isAgentInternalMessage(envelope)) {
            metadataDebounceManager.markFirstPublishDone(conversation.id);

            const summarizer = new ConversationSummarizer(projectCtx);
            summarizer.summarizeAndPublish(conversation).catch((error) => {
                logger.error("Failed to generate initial metadata for new conversation", {
                    conversationId: conversation.id,
                    error: formatAnyError(error),
                });
            });
            getSafeActiveSpan()?.addEvent("reply.initial_metadata_scheduled", {
                "conversation.id": shortenConversationId(conversation.id),
            });
            span.addEvent("dispatch.initial_metadata_scheduled", {
                "conversation.id": shortenConversationId(conversation.id),
            });
        }

        const whitelist = new Set(config.getConfig().whitelistedPubkeys ?? []);
        if (senderPubkey && whitelist.has(senderPubkey)) {
            const { unblocked } = AgentRouter.unblockAgent(envelope, conversation, projectCtx, whitelist);
            if (unblocked) {
                getSafeActiveSpan()?.addEvent("reply.agent_unblocked_by_whitelist", {
                    "event.pubkey": senderPubkey.substring(0, 8),
                });
                span.addEvent("dispatch.agent_unblocked", {
                    "event.pubkey": senderPubkey.substring(0, 8),
                });
            }
        }

        getSafeActiveSpan()?.addEvent("reply.before_agent_routing");
        const targetAgents = AgentRouter.resolveTargetAgents(envelope, projectCtx, conversation);
        const activeSpan = getSafeActiveSpan();
        if (activeSpan) {
            const mentionedPubkeys = getMentionedPubkeys(envelope);
            activeSpan.addEvent("agent_routing", {
                "routing.mentioned_pubkeys_count": mentionedPubkeys.length,
                "routing.resolved_agent_count": targetAgents.length,
                "routing.agent_names": targetAgents.map((agent) => agent.name).join(", "),
                "routing.agent_roles": targetAgents.map((agent) => agent.role).join(", "),
            });
        }

        span.addEvent("dispatch.routing_complete", {
            "routing.resolved_agent_count": targetAgents.length,
        });
        span.setAttributes({
            "routing.target_agent_count": targetAgents.length,
        });

        if (targetAgents.length === 0) {
            activeSpan?.addEvent("reply.no_target_agents", {
                "event.id": envelope.message.nativeId,
            });
            span.addEvent("dispatch.no_target_agents");
            return;
        }

        if (targetAgents.length > 1) {
            logger.warn("[dispatch] Multiple agents p-tagged, dispatching only to first", {
                dispatching: targetAgents[0].slug,
                skipped: targetAgents.slice(1).map(a => a.slug).join(", "),
            });
        }

        metadataDebounceManager.onAgentStart(conversation.id);

        await this.dispatchToAgent({
            targetAgent: targetAgents[0],
            envelope,
            conversationId: conversation.id,
            principalContext,
            projectCtx,
            agentExecutor,
            parentSpan: span,
        });

        if (!isAgentInternalMessage(envelope)) {
            metadataDebounceManager.schedulePublish(
                conversation.id,
                false,
                async () => {
                    const summarizer = new ConversationSummarizer(projectCtx);
                    await summarizer.summarizeAndPublish(conversation);
                }
            );
            getSafeActiveSpan()?.addEvent("reply.summarization_scheduled", {
                "conversation.id": shortenConversationId(conversation.id),
                debounced: true,
            });
            span.addEvent("dispatch.summarization_scheduled", {
                "conversation.id": shortenConversationId(conversation.id),
            });
        }
    }

    private async handleDelegationResponse(
        envelope: InboundEnvelope,
        delegationTarget: DelegationTarget,
        agentExecutor: AgentExecutor,
        projectCtx: ProjectContext,
        parentSpan: ReturnType<typeof tracer.startSpan>
    ): Promise<void> {
        const span = tracer.startSpan(
            "tenex.dispatch.delegation_response",
            {
                attributes: {
                    "delegation.agent_slug": delegationTarget.agent.slug,
                    "delegation.conversation_id": shortenConversationId(delegationTarget.conversationId),
                },
            },
            trace.setSpan(getSafeContext(), parentSpan)
        );

        try {
            const projectDTag = projectCtx.project.dTag;
            if (!projectDTag) throw new Error("Project missing d-tag");
            const isInCooldown = await this.checkAndBlockIfCooldown(
                projectDTag,
                delegationTarget.conversationId,
                delegationTarget.agent.pubkey,
                delegationTarget.agent.slug,
                span,
                "delegation_completion"
            );

            if (isInCooldown) {
                return;
            }

            const ralRegistry = RALRegistry.getInstance();
            const activeRal = ralRegistry.getState(
                delegationTarget.agent.pubkey,
                delegationTarget.conversationId
            );

            if (activeRal) {
                span.addEvent("dispatch.delegation_completion_received", {
                    "ral.number": activeRal.ralNumber,
                    "ral.is_streaming": activeRal.isStreaming,
                });
            }

            if (activeRal) {
                const completedDelegations = ralRegistry.getConversationCompletedDelegations(
                    delegationTarget.agent.pubkey,
                    delegationTarget.conversationId,
                    activeRal.ralNumber
                );

                const parentStore = ConversationStore.get(delegationTarget.conversationId);
                if (parentStore && completedDelegations.length > 0) {
                    let markersUpdated = 0;
                    for (const completion of completedDelegations) {
                        const updated = parentStore.updateDelegationMarker(
                            completion.delegationConversationId,
                            {
                                status: completion.status,
                                completedAt: completion.completedAt,
                                abortReason: completion.status === "aborted" ? completion.abortReason : undefined,
                            }
                        );
                        if (updated) {
                            markersUpdated += 1;
                        }
                    }

                    if (markersUpdated > 0) {
                        await parentStore.save();
                    }

                    span.addEvent("dispatch.markers_updated_before_debounce", {
                        "ral.number": activeRal.ralNumber,
                        "delegation.completed_count": completedDelegations.length,
                        "markers.updated_count": markersUpdated,
                    });
                }
            }

            if (!envelope.metadata.isKillSignal) {
                const debounceKey = `${delegationTarget.agent.pubkey}:${delegationTarget.conversationId}`;
                const debounceSequence = await this.waitForDelegationDebounce(debounceKey, span);
                if (this.delegationDebounceSequence.get(debounceKey) !== debounceSequence) {
                    span.addEvent("dispatch.delegation_debounce_skipped", {
                        "debounce.sequence": debounceSequence,
                    });
                    span.setStatus({ code: SpanStatusCode.OK });
                    return;
                }
                this.delegationDebounceSequence.delete(debounceKey);
            }

            const currentRal = ralRegistry.getState(
                delegationTarget.agent.pubkey,
                delegationTarget.conversationId
            );
            if (currentRal?.isStreaming) {
                const completedDelegations = ralRegistry.getConversationCompletedDelegations(
                    delegationTarget.agent.pubkey,
                    delegationTarget.conversationId,
                    currentRal.ralNumber
                );
                const pendingDelegations = ralRegistry.getConversationPendingDelegations(
                    delegationTarget.agent.pubkey,
                    delegationTarget.conversationId,
                    currentRal.ralNumber
                );

                const parentStore = ConversationStore.get(delegationTarget.conversationId);
                if (parentStore && completedDelegations.length > 0) {
                    for (const completion of completedDelegations) {
                        const updated = parentStore.updateDelegationMarker(
                            completion.delegationConversationId,
                            {
                                status: completion.status,
                                completedAt: completion.completedAt,
                                abortReason: completion.status === "aborted" ? completion.abortReason : undefined,
                            }
                        );

                        if (!updated) {
                            const marker: DelegationMarker = {
                                delegationConversationId: completion.delegationConversationId,
                                recipientPubkey: completion.recipientPubkey,
                                parentConversationId: delegationTarget.conversationId,
                                completedAt: completion.completedAt,
                                status: completion.status,
                                abortReason: completion.status === "aborted" ? completion.abortReason : undefined,
                            };
                            parentStore.addDelegationMarker(
                                marker,
                                delegationTarget.agent.pubkey,
                                currentRal.ralNumber
                            );
                        }
                    }
                    await parentStore.save();

                    ralRegistry.clearCompletedDelegations(
                        delegationTarget.agent.pubkey,
                        delegationTarget.conversationId,
                        currentRal.ralNumber
                    );
                }

                span.addEvent("dispatch.delegation_markers_inserted_for_active_stream", {
                    "ral.number": currentRal.ralNumber,
                    "delegation.completed_count": completedDelegations.length,
                    "delegation.pending_count": pendingDelegations.length,
                });
                span.setStatus({ code: SpanStatusCode.OK });
                return;
            }

            const resumableRal = ralRegistry.findResumableRAL(
                delegationTarget.agent.pubkey,
                delegationTarget.conversationId
            );

            if (!resumableRal && envelope.metadata.isKillSignal) {
                span.addEvent("dispatch.kill_wakeup_no_resumable_ral");
                logger.warn("[handleDelegationResponse] Kill wake-up: no resumable RAL found for parent agent, skipping", {
                    agentSlug: delegationTarget.agent.slug,
                    conversationId: shortenConversationId(delegationTarget.conversationId),
                });
                span.setStatus({ code: SpanStatusCode.OK });
                return;
            }

            let triggeringEnvelopeForContext = envelope;
            if (resumableRal?.originalTriggeringEventId) {
                const originalEnvelope = ConversationStore.getCachedEnvelope(
                    resumableRal.originalTriggeringEventId
                );
                if (originalEnvelope) {
                    triggeringEnvelopeForContext = originalEnvelope;
                    getSafeActiveSpan()?.addEvent("reply.restored_original_trigger_for_delegation", {
                        "original.event_id": resumableRal.originalTriggeringEventId,
                        "completion.event_id": envelope.message.nativeId,
                    });
                    span.addEvent("dispatch.delegation_restored_trigger", {
                        "original.event_id": resumableRal.originalTriggeringEventId,
                    });
                } else if (envelope.metadata.isKillSignal) {
                    throw new Error(
                        `[handleDelegationResponse] Kill wake-up: original trigger envelope (${resumableRal.originalTriggeringEventId.substring(0, 8)}) not in cache — cannot safely proceed`
                    );
                }
            }

            getSafeActiveSpan()?.addEvent("reply.delegation_routing_to_original", {
                "delegation.agent_slug": delegationTarget.agent.slug,
                "delegation.original_conversation_id": shortenConversationId(delegationTarget.conversationId),
            });

            const pendingDelegations = ralRegistry.getConversationPendingDelegations(
                delegationTarget.agent.pubkey,
                delegationTarget.conversationId,
                resumableRal?.ralNumber
            );
            const hasPendingDelegations = pendingDelegations.length > 0;

            span.addEvent("dispatch.hasPendingDelegations_captured", {
                hasPendingDelegations,
                "pendingDelegations.count": pendingDelegations.length,
                "pendingDelegations.ids": pendingDelegations.map((item) => item.delegationConversationId).join(","),
                "ral.number": resumableRal?.ralNumber ?? -1,
            });

            span.setAttributes({
                "delegation.pending_count": pendingDelegations.length,
            });

            const executionContext = await createExecutionContext({
                agent: delegationTarget.agent,
                conversationId: delegationTarget.conversationId,
                projectBasePath: projectCtx.agentRegistry.getBasePath(),
                triggeringEnvelope: triggeringEnvelopeForContext,
                isDelegationCompletion: true,
                hasPendingDelegations,
                mcpManager: projectCtx.mcpManager,
            });

            metadataDebounceManager.onAgentStart(delegationTarget.conversationId);

            await otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
                await agentExecutor.execute(executionContext);
            });

            metadataDebounceManager.schedulePublish(
                delegationTarget.conversationId,
                false,
                async () => {
                    const summarizer = new ConversationSummarizer(projectCtx);
                    const originalConversation = ConversationStore.get(delegationTarget.conversationId);
                    if (originalConversation) {
                        await summarizer.summarizeAndPublish(originalConversation);
                    }
                }
            );

            span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
            span.recordException(error as Error);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (error as Error).message,
            });
            logger.writeToWarnLog({
                timestamp: new Date().toISOString(),
                level: "error",
                component: "AgentDispatchService",
                message: "Delegation routing execution failed",
                context: {
                    agentSlug: delegationTarget.agent.slug,
                    conversationId: delegationTarget.conversationId,
                    triggerEventId: envelope.message.nativeId,
                },
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
        } finally {
            span.end();
        }
    }

    private async waitForDelegationDebounce(
        key: string,
        span: ReturnType<typeof tracer.startSpan>
    ): Promise<number> {
        const nextSequence = (this.delegationDebounceSequence.get(key) ?? 0) + 1;
        this.delegationDebounceSequence.set(key, nextSequence);

        let state = this.delegationDebounceState.get(key);
        if (!state) {
            let resolveFn: (() => void) | undefined;
            const promise = new Promise<void>((resolve) => {
                resolveFn = resolve;
            });
            const timeout = setTimeout(() => {
                this.delegationDebounceState.delete(key);
                resolveFn?.();
            }, DELEGATION_COMPLETION_DEBOUNCE_MS);
            state = {
                timeout,
                promise,
                resolve: resolveFn ?? (() => {}),
            };
            this.delegationDebounceState.set(key, state);
        } else {
            clearTimeout(state.timeout);
            state.timeout = setTimeout(() => {
                this.delegationDebounceState.delete(key);
                state?.resolve();
            }, DELEGATION_COMPLETION_DEBOUNCE_MS);
        }

        span.addEvent("dispatch.delegation_debounce_scheduled", {
            "debounce.ms": DELEGATION_COMPLETION_DEBOUNCE_MS,
            "debounce.sequence": nextSequence,
        });

        await state.promise;
        return nextSequence;
    }

    private async dispatchToAgent(params: {
        targetAgent: AgentInstance;
        envelope: InboundEnvelope;
        conversationId: string;
        principalContext?: MessagePrincipalContext;
        projectCtx: ProjectContext;
        agentExecutor: AgentExecutor;
        parentSpan: ReturnType<typeof tracer.startSpan>;
    }): Promise<void> {
        const {
            targetAgent,
            envelope,
            conversationId,
            principalContext,
            projectCtx,
            agentExecutor,
            parentSpan,
        } = params;
        const ralRegistry = RALRegistry.getInstance();
        const dispatchContext = trace.setSpan(getSafeContext(), parentSpan);

        const agentSpan = tracer.startSpan(
            "tenex.dispatch.agent",
            {
                attributes: {
                    "agent.slug": targetAgent.slug,
                    "agent.pubkey": targetAgent.pubkey,
                    "conversation.id": shortenConversationId(conversationId),
                },
            },
            dispatchContext
        );

        // Tracks the resumption claim acquired (if any) by this dispatcher in
        // `handleDeliveryInjection`. Released in the `finally` below unless
        // the StreamExecutionHandler handed off ownership to the live stream.
        // Held at dispatchToAgent scope (not AgentExecutor scope) because
        // `createExecutionContext` can throw before `agentExecutor.execute()`
        // is even invoked, and we still need to release the claim in that case.
        let resumptionClaim: { ralNumber: number; token: string } | undefined;

        try {
            const projectDTag = projectCtx.project.dTag;
            if (!projectDTag) throw new Error("Project missing d-tag");
            const isInCooldown = await this.checkAndBlockIfCooldown(
                projectDTag,
                conversationId,
                targetAgent.pubkey,
                targetAgent.slug,
                agentSpan,
                "routing"
            );

            if (isInCooldown) {
                return;
            }

            const activeRal = ralRegistry.getState(targetAgent.pubkey, conversationId);
            agentSpan.setAttributes({
                "ral.is_active": !!activeRal,
                "ral.is_streaming": activeRal?.isStreaming ?? false,
                "ral.number": activeRal?.ralNumber ?? 0,
            });

            const deliveryResult = await this.handleDeliveryInjection({
                activeRal,
                agent: targetAgent,
                conversationId,
                message: envelope.content,
                senderPubkey: envelope.principal.linkedPubkey,
                senderPrincipal: principalContext?.senderPrincipal,
                targetedPrincipals: principalContext?.targetedPrincipals,
                eventId: envelope.message.nativeId,
                agentSpan,
            });

            resumptionClaim = deliveryResult.claim;

            if (deliveryResult.skipExecution) {
                agentSpan.addEvent("dispatch.execution_skipped_injection_queued");
                agentSpan.setStatus({ code: SpanStatusCode.OK });
                return;
            }

            let triggeringEnvelopeForContext = envelope;
            // When we hold a claim, the resumption target is pinned — use
            // that RAL's original triggering event to preserve thread context.
            // Otherwise fall back to discovery for the no-claim path (fresh
            // conversations where `activeRal` was undefined).
            const resumptionTargetRal = resumptionClaim
                ? ralRegistry.getRAL(targetAgent.pubkey, conversationId, resumptionClaim.ralNumber)
                : ralRegistry.findResumableRAL(targetAgent.pubkey, conversationId);

            if (resumptionTargetRal?.originalTriggeringEventId) {
                const originalEnvelope = ConversationStore.getCachedEnvelope(
                    resumptionTargetRal.originalTriggeringEventId
                );
                if (originalEnvelope) {
                    triggeringEnvelopeForContext = originalEnvelope;
                    getSafeActiveSpan()?.addEvent("reply.restored_original_trigger", {
                        "agent.slug": targetAgent.slug,
                        "original.event_id": resumptionTargetRal.originalTriggeringEventId,
                        "resumption.event_id": envelope.message.nativeId,
                    });
                    agentSpan.addEvent("dispatch.restored_original_trigger", {
                        "original.event_id": resumptionTargetRal.originalTriggeringEventId,
                    });
                }
            }

            const executionContext = await createExecutionContext({
                agent: targetAgent,
                conversationId,
                projectBasePath: projectCtx.agentRegistry.getBasePath(),
                triggeringEnvelope: triggeringEnvelopeForContext,
                mcpManager: projectCtx.mcpManager,
            });

            if (resumptionClaim) {
                executionContext.preferredRalNumber = resumptionClaim.ralNumber;
                executionContext.preferredRalClaimToken = resumptionClaim.token;
            }

            await otelContext.with(trace.setSpan(otelContext.active(), agentSpan), async () => {
                if (isAgentWorkerDispatchEnabled()) {
                    const workerIneligibility = getAgentWorkerDispatchIneligibility({
                        executionContext,
                        projectCtx,
                        targetAgent,
                        activeRal,
                        resumptionClaim,
                    });

                    if (!workerIneligibility) {
                        agentSpan.addEvent("dispatch.agent_worker_selected");
                        await executeDispatchViaAgentWorker({
                            executionContext,
                            projectCtx,
                            targetAgent,
                        });
                        return;
                    }

                    agentSpan.addEvent("dispatch.agent_worker_skipped", {
                        "worker.skip_reason": workerIneligibility,
                    });
                }

                await agentExecutor.execute(executionContext);
            });

            agentSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
            agentSpan.recordException(error as Error);
            agentSpan.setStatus({
                code: SpanStatusCode.ERROR,
                message: (error as Error).message,
            });
            logger.writeToWarnLog({
                timestamp: new Date().toISOString(),
                level: "error",
                component: "AgentDispatchService",
                message: "Agent execution failed during dispatch",
                context: {
                    agentSlug: targetAgent.slug,
                    conversationId,
                    triggerEventId: envelope.message.nativeId,
                },
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
        } finally {
            // Release the resumption claim on any exit path. `releaseResumptionClaim`
            // only releases if the token still matches: if StreamExecutionHandler
            // already handed off the claim (via `handOffResumptionClaimToStream`),
            // the token has been cleared and this call is a no-op. This prevents
            // us from clearing a claim that a subsequent dispatch may have
            // re-acquired after `cleanup()` flipped `isStreaming` back to false.
            if (resumptionClaim) {
                ralRegistry.releaseResumptionClaim(
                    targetAgent.pubkey,
                    conversationId,
                    resumptionClaim.ralNumber,
                    resumptionClaim.token
                );
            }
            agentSpan.end();
        }
    }

    private async checkAndBlockIfCooldown(
        projectId: string,
        conversationId: string,
        agentPubkey: string,
        agentSlug: string,
        span: ReturnType<typeof tracer.startSpan>,
        eventType: "delegation_completion" | "routing"
    ): Promise<boolean> {
        const cooldownRegistry = CooldownRegistry.getInstance();

        if (cooldownRegistry.isInCooldown(projectId, conversationId, agentPubkey)) {
            logger.info(`[dispatch] ${eventType === "delegation_completion" ? "Delegation completion routing" : "Routing"} blocked due to cooldown`, {
                projectId: projectId.substring(0, 12),
                conversationId: shortenConversationId(conversationId),
                agentSlug,
                agentPubkey: shortenPubkey(agentPubkey),
            });

            span.addEvent(`dispatch.${eventType}_blocked_cooldown`, {
                "cooldown.project_id": projectId.substring(0, 12),
                "cooldown.conversation_id": shortenConversationId(conversationId),
                "cooldown.agent_pubkey": shortenPubkey(agentPubkey),
                "cooldown.agent_slug": agentSlug,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return true;
        }

        return false;
    }

    private async handleDeliveryInjection(params: {
        activeRal: RALRegistryEntry | undefined;
        agent: AgentInstance;
        conversationId: string;
        message: string;
        senderPubkey?: string;
        senderPrincipal?: PrincipalSnapshot;
        targetedPrincipals?: PrincipalSnapshot[];
        eventId?: string;
        agentSpan: ReturnType<typeof tracer.startSpan>;
    }): Promise<DeliveryInjectionResult> {
        const {
            activeRal,
            agent,
            conversationId,
            message,
            senderPubkey,
            senderPrincipal,
            targetedPrincipals,
            eventId,
            agentSpan,
        } = params;

        if (!activeRal) {
            return { skipExecution: false };
        }

        const ralRegistry = RALRegistry.getInstance();
        const messageLength = message.length;

        ralRegistry.queueUserMessage(
            agent.pubkey,
            conversationId,
            activeRal.ralNumber,
            message,
            { senderPubkey, senderPrincipal, targetedPrincipals, eventId }
        );

        if (activeRal.isStreaming) {
            const llmConfig = config.getLLMConfig(agent.llmConfig);
            const liveInjection = await this.tryDeliverQueuedMessageToLiveStream({
                agent,
                conversationId,
                message,
                eventId,
                agentSpan,
                provider: llmConfig.provider,
            });

            getSafeActiveSpan()?.addEvent("reply.message_injected_no_abort", {
                "agent.slug": agent.slug,
                "ral.number": activeRal.ralNumber,
                "message.length": messageLength,
                provider: llmConfig.provider,
                "injection.injector_available": liveInjection.injectorAvailable,
                "injection.delivered_live": liveInjection.delivered,
            });
            logger.info("[reply] Queued message for streaming provider (no abort, skipping execution)", {
                agent: agent.slug,
                ralNumber: activeRal.ralNumber,
                injectionLength: messageLength,
                provider: llmConfig.provider,
                injectorAvailable: liveInjection.injectorAvailable,
                deliveredLive: liveInjection.delivered,
            });
            agentSpan.addEvent("dispatch.injection_stream_no_abort_skip_execution", {
                "message.length": messageLength,
                provider: llmConfig.provider,
                "injection.injector_available": liveInjection.injectorAvailable,
                "injection.delivered_live": liveInjection.delivered,
            });
            return { skipExecution: true };
        }

        // The RAL is idle and potentially resumable. Two concurrent dispatches
        // may both observe this state via `getState`; without serialization,
        // both would proceed to execute() and both would resume the same RAL.
        // Atomically claim the right to wake this RAL up — only one concurrent
        // dispatch wins. The loser's message has already been queued onto the
        // same ralNumber above and will be drained by the winner's execution
        // via `StreamSetup.getAndConsumeInjections`.
        const claimToken = ralRegistry.tryAcquireResumptionClaim(
            agent.pubkey,
            conversationId,
            activeRal.ralNumber
        );

        if (claimToken === undefined) {
            getSafeActiveSpan()?.addEvent("reply.message_queued_concurrent_claim_lost", {
                "agent.slug": agent.slug,
                "ral.number": activeRal.ralNumber,
                "message.length": messageLength,
            });
            agentSpan.addEvent("dispatch.injection_resumption_claim_lost", {
                "ral.number": activeRal.ralNumber,
                "message.length": messageLength,
            });
            logger.info("[reply] Queued message for concurrent dispatch to pick up", {
                agent: agent.slug,
                ralNumber: activeRal.ralNumber,
                injectionLength: messageLength,
            });
            return { skipExecution: true };
        }

        getSafeActiveSpan()?.addEvent("reply.message_queued_for_resumption", {
            "agent.slug": agent.slug,
            "ral.number": activeRal.ralNumber,
            "message.length": messageLength,
        });
        agentSpan.addEvent("dispatch.injection_resumption", {
            "ral.number": activeRal.ralNumber,
            "message.length": messageLength,
            "claim.token": claimToken,
        });
        return {
            skipExecution: false,
            claim: { ralNumber: activeRal.ralNumber, token: claimToken },
        };
    }

    private toMessagePrincipalContext(envelope: InboundEnvelope): MessagePrincipalContext {
        return {
            senderPrincipal: envelope.principal,
            targetedPrincipals: envelope.recipients.length > 0 ? envelope.recipients : undefined,
        };
    }

    private async tryDeliverQueuedMessageToLiveStream(params: {
        agent: AgentInstance;
        conversationId: string;
        message: string;
        eventId?: string;
        provider: string;
        agentSpan: ReturnType<typeof tracer.startSpan>;
    }): Promise<{ injectorAvailable: boolean; delivered: boolean }> {
        const { agent, conversationId, message, eventId, provider, agentSpan } = params;
        const injector = llmOpsRegistry.getMessageInjector(agent.pubkey, conversationId);

        if (!injector) {
            agentSpan.addEvent("dispatch.injection_live_unavailable", {
                provider,
            });
            return { injectorAvailable: false, delivered: false };
        }

        const delivered = await new Promise<boolean>((resolve) => {
            let settled = false;
            const timeoutId = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    resolve(false);
                }
            }, LIVE_INJECTION_TIMEOUT_MS);

            const finish = (result: boolean): void => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timeoutId);
                resolve(result);
            };

            try {
                injector.inject(message, finish);
            } catch (error) {
                logger.warn("[reply] Live message injection threw synchronously", {
                    agent: agent.slug,
                    conversationId: shortenConversationId(conversationId),
                    provider,
                    error: formatAnyError(error),
                });
                finish(false);
            }
        });

        if (!delivered) {
            agentSpan.addEvent("dispatch.injection_live_failed", {
                provider,
            });
            return { injectorAvailable: true, delivered: false };
        }

        let clearedCount = 0;
        if (eventId) {
            clearedCount = RALRegistry.getInstance().clearQueuedInjectionByEventId(
                agent.pubkey,
                conversationId,
                eventId
            );
        }

        agentSpan.addEvent("dispatch.injection_live_delivered", {
            provider,
            "queue.cleared_count": clearedCount,
        });

        return { injectorAvailable: true, delivered: true };
    }
}
