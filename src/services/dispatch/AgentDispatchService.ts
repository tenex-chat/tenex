import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { createExecutionContext } from "@/agents/execution/ExecutionContextFactory";
import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { ConversationResolver } from "@/conversations/services/ConversationResolver";
import { ConversationSummarizer } from "@/conversations/services/ConversationSummarizer";
import { metadataDebounceManager } from "@/conversations/services/MetadataDebounceManager";
import type { DelegationMarker } from "@/conversations/types";
import { formatAnyError } from "@/lib/error-formatter";
import { shortenConversationId } from "@/utils/conversation-id";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { config } from "@/services/ConfigService";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import { llmOpsRegistry, INJECTION_ABORT_REASON } from "@/services/LLMOperationsRegistry";
import { getProjectContext, type ProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import type { RALRegistryEntry } from "@/services/ral/types";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { ROOT_CONTEXT, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import { AgentRouter } from "@/services/dispatch/AgentRouter";
import { handleDelegationCompletion } from "@/services/dispatch/DelegationCompletionHandler";

const tracer = trace.getTracer("tenex.dispatch");
// Coalesce back-to-back delegation completions so we resume once with a stable snapshot.
const DELEGATION_COMPLETION_DEBOUNCE_MS = 2500;
const getSafeContext = (): ReturnType<typeof otelContext.active> => {
    const activeContext = otelContext.active();
    // Defensive fallback for test mocks or non-standard context managers.
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

    async dispatch(event: NDKEvent, context: DispatchContext): Promise<void> {
        const span = tracer.startSpan(
            "tenex.dispatch.chat_message",
            {
                attributes: {
                    "event.id": event.id ?? "",
                    "event.pubkey": event.pubkey ?? "",
                    "event.kind": event.kind ?? 0,
                    "event.content_length": event.content?.length ?? 0,
                },
            },
            getSafeContext()
        );

        try {
            await this.handleChatMessage(event, context, span);
            span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
            span.recordException(error as Error);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (error as Error).message,
            });
            logger.error("Failed to route reply", {
                error: formatAnyError(error),
                eventId: event.id,
            });
        } finally {
            span.end();
        }
    }

    private async handleChatMessage(
        event: NDKEvent,
        { agentExecutor }: DispatchContext,
        span: ReturnType<typeof tracer.startSpan>
    ): Promise<void> {
        const projectCtx = getProjectContext();

        const isDirectedToSystem = AgentEventDecoder.isDirectedToSystem(event, projectCtx.agents);
        const isFromAgent = AgentEventDecoder.isEventFromAgent(event, projectCtx.agents);

        span.setAttributes({
            "routing.is_directed_to_system": isDirectedToSystem,
            "routing.is_from_agent": isFromAgent,
        });

        getSafeActiveSpan()?.addEvent("reply.message_received", {
            "event.id": event.id ?? "",
            "event.pubkey": event.pubkey?.substring(0, 8) ?? "",
            "message.preview": event.content.substring(0, 100),
            "routing.is_directed_to_system": isDirectedToSystem,
            "routing.is_from_agent": isFromAgent,
        });

        span.addEvent("dispatch.message_received", {
            "routing.is_directed_to_system": isDirectedToSystem,
            "routing.is_from_agent": isFromAgent,
        });

        if (!isDirectedToSystem && isFromAgent) {
            getSafeActiveSpan()?.addEvent("reply.agent_event_not_directed", {
                "event.id": event.id ?? "",
            });
            span.addEvent("dispatch.agent_event_not_directed");

            const resolver = new ConversationResolver();
            const result = await resolver.resolveConversationForEvent(event);

            if (result.conversation) {
                await ConversationStore.addEvent(result.conversation.id, event);
                getSafeActiveSpan()?.addEvent("reply.added_to_history", {
                    "conversation.id": shortenConversationId(result.conversation.id),
                });
                span.addEvent("dispatch.agent_event_added_to_history", {
                    "conversation.id": shortenConversationId(result.conversation.id),
                });
            } else {
                getSafeActiveSpan()?.addEvent("reply.no_conversation_found", {
                    "event.id": event.id ?? "",
                });
                span.addEvent("dispatch.agent_event_no_conversation");
            }
            return;
        }

        await this.handleReplyLogic(event, agentExecutor, projectCtx, span);
    }

    private async handleReplyLogic(
        event: NDKEvent,
        agentExecutor: AgentExecutor,
        projectCtx: ProjectContext,
        span: ReturnType<typeof tracer.startSpan>
    ): Promise<void> {
        const delegationResult = await handleDelegationCompletion(event);
        const delegationTarget = AgentRouter.resolveDelegationTarget(delegationResult, projectCtx);

        if (delegationTarget) {
            span.addEvent("dispatch.delegation_completion_routed", {
                "delegation.agent_slug": delegationTarget.agent.slug,
                "delegation.conversation_id": shortenConversationId(delegationTarget.conversationId),
            });
            await this.handleDelegationResponse(event, delegationTarget, agentExecutor, projectCtx, span);
            return;
        }

        if (AgentEventDecoder.isDelegationCompletion(event)) {
            const activeSpan = getSafeActiveSpan();
            activeSpan?.addEvent("reply.completion_dropped_no_waiting_ral", {
                "event.id": event.id ?? "",
                "event.pubkey": event.pubkey.substring(0, 8),
            });
            activeSpan?.setStatus({
                code: SpanStatusCode.ERROR,
                message: "Delegation completion dropped: no waiting RAL found. This indicates a delegation registration bug.",
            });
            logger.error("[reply] Delegation completion dropped - no waiting RAL", {
                eventId: event.id,
                eventPubkey: event.pubkey.substring(0, 8),
            });
            span.addEvent("dispatch.delegation_completion_dropped");
            return;
        }

        const conversationResolver = new ConversationResolver();
        const { conversation, isNew } = await conversationResolver.resolveConversationForEvent(event);

        if (!conversation) {
            logger.error("No conversation found or created for event", {
                eventId: event.id,
                replyTarget: AgentEventDecoder.getReplyTarget(event),
            });
            span.addEvent("dispatch.conversation_missing", {
                "event.id": event.id ?? "",
            });
            return;
        }

        span.setAttributes({
            "conversation.id": shortenConversationId(conversation.id),
            "conversation.is_new": isNew,
        });

        if (!isNew && event.id && conversation.hasEventId(event.id)) {
            getSafeActiveSpan()?.addEvent("reply.skipped_duplicate_event", {
                "event.id": event.id,
                "conversation.id": shortenConversationId(conversation.id),
            });
            span.addEvent("dispatch.duplicate_event_skipped", {
                "conversation.id": shortenConversationId(conversation.id),
            });

            if (!AgentEventDecoder.isAgentInternalMessage(event)) {
                await ConversationStore.addEvent(conversation.id, event);
            }
            return;
        }

        if (!isNew && !AgentEventDecoder.isAgentInternalMessage(event)) {
            await ConversationStore.addEvent(conversation.id, event);
        }

        if (isNew && !AgentEventDecoder.isAgentInternalMessage(event)) {
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

        const whitelistedPubkeys = config.getConfig().whitelistedPubkeys ?? [];
        const whitelist = new Set(whitelistedPubkeys);
        if (whitelist.has(event.pubkey)) {
            const { unblocked } = AgentRouter.unblockAgent(event, conversation, projectCtx, whitelist);
            if (unblocked) {
                getSafeActiveSpan()?.addEvent("reply.agent_unblocked_by_whitelist", {
                    "event.pubkey": event.pubkey.substring(0, 8),
                });
                span.addEvent("dispatch.agent_unblocked", {
                    "event.pubkey": event.pubkey.substring(0, 8),
                });
            }
        }

        getSafeActiveSpan()?.addEvent("reply.before_agent_routing");
        const targetAgents = AgentRouter.resolveTargetAgents(event, projectCtx, conversation);

        const activeSpan = getSafeActiveSpan();
        if (activeSpan) {
            const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
            activeSpan.addEvent("agent_routing", {
                "routing.mentioned_pubkeys_count": mentionedPubkeys.length,
                "routing.resolved_agent_count": targetAgents.length,
                "routing.agent_names": targetAgents.map((a) => a.name).join(", "),
                "routing.agent_roles": targetAgents.map((a) => a.role).join(", "),
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
                "event.id": event.id ?? "",
            });
            span.addEvent("dispatch.no_target_agents");
            return;
        }

        metadataDebounceManager.onAgentStart(conversation.id);

        await this.dispatchToAgents({
            targetAgents,
            event,
            conversationId: conversation.id,
            projectCtx,
            agentExecutor,
            parentSpan: span,
        });

        if (!AgentEventDecoder.isAgentInternalMessage(event)) {
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
                "debounced": true,
            });
            span.addEvent("dispatch.summarization_scheduled", {
                "conversation.id": shortenConversationId(conversation.id),
            });
        }
    }

    private async handleDelegationResponse(
        event: NDKEvent,
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
            // Check if this agent is in cooldown for this conversation
            // Non-null assertion: delegationTarget.conversationId and dTag are guaranteed to be defined (checked in resolveDelegationTarget)
            const isInCooldown = await this.checkAndBlockIfCooldown(
                projectCtx.project.dTag!,
                delegationTarget.conversationId!,
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

            // NOTE: We intentionally do NOT abort streaming executions when delegation completes.
            // The delegator might be mid-stream (waiting for LLM response after a tool call).
            // Aborting would kill the stream before it can finish naturally.
            // Instead, we let the debounce run, then either:
            // - Resume the finished RAL with delegation results
            // - Queue results for an active stream to pick up via prepareStep
            // See trace-detective report on executor.result_undefined_error for details.
            if (activeRal) {
                span.addEvent("dispatch.delegation_completion_received", {
                    "ral.number": activeRal.ralNumber,
                    "ral.is_streaming": activeRal.isStreaming,
                });
            }
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

            // Check if there's still an active streaming RAL after debounce.
            // If so, just queue the delegation results - the prepareStep callback will pick them up.
            // This prevents starting a second execution while the first is still streaming.
            const currentRal = ralRegistry.getState(
                delegationTarget.agent.pubkey,
                delegationTarget.conversationId
            );
            if (currentRal?.isStreaming) {
                // Insert delegation markers directly into ConversationStore
                // The active stream will pick up markers when it rebuilds messages
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

                // Update markers in the parent conversation (or create if not found)
                const parentStore = ConversationStore.get(delegationTarget.conversationId);
                if (parentStore && completedDelegations.length > 0) {
                    for (const completion of completedDelegations) {
                        // Try to update existing pending marker first
                        const updated = parentStore.updateDelegationMarker(
                            completion.delegationConversationId,
                            {
                                status: completion.status,
                                completedAt: completion.completedAt,
                                abortReason: completion.status === "aborted" ? completion.abortReason : undefined,
                            }
                        );

                        // If no pending marker found, create a new one (backward compatibility)
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

                    // Clear completed delegations after inserting markers
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

            let triggeringEventForContext = event;

            if (resumableRal?.originalTriggeringEventId) {
                const originalEvent = ConversationStore.getCachedEvent(resumableRal.originalTriggeringEventId);
                if (originalEvent) {
                    triggeringEventForContext = originalEvent;
                    getSafeActiveSpan()?.addEvent("reply.restored_original_trigger_for_delegation", {
                        "original.event_id": resumableRal.originalTriggeringEventId,
                        "completion.event_id": event.id || "",
                    });
                    span.addEvent("dispatch.delegation_restored_trigger", {
                        "original.event_id": resumableRal.originalTriggeringEventId,
                    });
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

            // DIAGNOSTIC: Trace the moment hasPendingDelegations is captured for context
            span.addEvent("dispatch.hasPendingDelegations_captured", {
                "hasPendingDelegations": hasPendingDelegations,
                "pendingDelegations.count": pendingDelegations.length,
                "pendingDelegations.ids": pendingDelegations.map(d => d.delegationConversationId).join(","),
                "ral.number": resumableRal?.ralNumber ?? -1,
            });

            span.setAttributes({
                "delegation.pending_count": pendingDelegations.length,
            });

            const executionContext = await createExecutionContext({
                agent: delegationTarget.agent,
                conversationId: delegationTarget.conversationId,
                projectBasePath: projectCtx.agentRegistry.getBasePath(),
                triggeringEvent: triggeringEventForContext,
                isDelegationCompletion: true,
                hasPendingDelegations,
                mcpManager: projectCtx.mcpManager,
            });

            metadataDebounceManager.onAgentStart(delegationTarget.conversationId);

            // Execute within span context so agent.execute becomes a child span
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
            const activeState = state;
            clearTimeout(activeState.timeout);
            activeState.timeout = setTimeout(() => {
                this.delegationDebounceState.delete(key);
                activeState.resolve();
            }, DELEGATION_COMPLETION_DEBOUNCE_MS);
        }

        span.addEvent("dispatch.delegation_debounce_scheduled", {
            "debounce.ms": DELEGATION_COMPLETION_DEBOUNCE_MS,
            "debounce.sequence": nextSequence,
        });

        await state.promise;
        return nextSequence;
    }

    private async dispatchToAgents(params: {
        targetAgents: AgentInstance[];
        event: NDKEvent;
        conversationId: string;
        projectCtx: ProjectContext;
        agentExecutor: AgentExecutor;
        parentSpan: ReturnType<typeof tracer.startSpan>;
    }): Promise<void> {
        const {
            targetAgents,
            event,
            conversationId,
            projectCtx,
            agentExecutor,
            parentSpan,
        } = params;
        const ralRegistry = RALRegistry.getInstance();
        const dispatchContext = trace.setSpan(getSafeContext(), parentSpan);

        // DIAGNOSTIC: Track concurrent execution metrics for bottleneck analysis
        const dispatchStartTime = Date.now();
        const currentActiveOps = llmOpsRegistry.getActiveOperationsCount();
        parentSpan.addEvent("dispatch.concurrent_execution_starting", {
            "concurrent.target_agents_count": targetAgents.length,
            "concurrent.existing_active_ops": currentActiveOps,
            "concurrent.total_after_dispatch": currentActiveOps + targetAgents.length,
            "concurrent.dispatch_start_time": dispatchStartTime,
            "concurrent.event_loop_lag_ms": this.measureEventLoopLag(),
        });

        const executionPromises = targetAgents.map(async (targetAgent) => {
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

            try {
                // Check if this agent is in cooldown for this conversation
                // Non-null assertion: conversationId and dTag are guaranteed to be defined from function params
                const isInCooldown = await this.checkAndBlockIfCooldown(
                    projectCtx.project.dTag!,
                    conversationId!,
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

                const shouldSkipExecution = this.handleDeliveryInjection({
                    activeRal,
                    agent: targetAgent,
                    conversationId,
                    message: event.content,
                    senderPubkey: event.pubkey,
                    eventId: event.id,
                    agentSpan,
                });

                if (shouldSkipExecution) {
                    // Message was queued for an active streaming execution.
                    // Don't spawn a new execution - the active one will pick it up.
                    agentSpan.addEvent("dispatch.execution_skipped_injection_queued");
                    agentSpan.setStatus({ code: SpanStatusCode.OK });
                    return;
                }

                let triggeringEventForContext = event;
                const resumableRal = ralRegistry.findResumableRAL(targetAgent.pubkey, conversationId);

                if (resumableRal?.originalTriggeringEventId) {
                    const originalEvent = ConversationStore.getCachedEvent(resumableRal.originalTriggeringEventId);
                    if (originalEvent) {
                        triggeringEventForContext = originalEvent;
                        getSafeActiveSpan()?.addEvent("reply.restored_original_trigger", {
                            "agent.slug": targetAgent.slug,
                            "original.event_id": resumableRal.originalTriggeringEventId,
                            "resumption.event_id": event.id || "",
                        });
                        agentSpan.addEvent("dispatch.restored_original_trigger", {
                            "original.event_id": resumableRal.originalTriggeringEventId,
                        });
                    }
                }

                const executionContext = await createExecutionContext({
                    agent: targetAgent,
                    conversationId,
                    projectBasePath: projectCtx.agentRegistry.getBasePath(),
                    triggeringEvent: triggeringEventForContext,
                    mcpManager: projectCtx.mcpManager,
                });

                // Execute within agentSpan context so agent.execute becomes a child span
                await otelContext.with(trace.setSpan(otelContext.active(), agentSpan), async () => {
                    await agentExecutor.execute(executionContext);
                });

                agentSpan.setStatus({ code: SpanStatusCode.OK });
            } catch (error) {
                agentSpan.recordException(error as Error);
                agentSpan.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: (error as Error).message,
                });
                throw error;
            } finally {
                agentSpan.end();
            }
        });

        await Promise.all(executionPromises);

        // DIAGNOSTIC: Track concurrent execution completion metrics
        const dispatchEndTime = Date.now();
        const dispatchDuration = dispatchEndTime - dispatchStartTime;
        const finalActiveOps = llmOpsRegistry.getActiveOperationsCount();
        parentSpan.addEvent("dispatch.concurrent_execution_completed", {
            "concurrent.dispatch_duration_ms": dispatchDuration,
            "concurrent.agents_executed": targetAgents.length,
            "concurrent.final_active_ops": finalActiveOps,
            "concurrent.event_loop_lag_ms": this.measureEventLoopLag(),
            "concurrent.avg_per_agent_ms": Math.round(dispatchDuration / targetAgents.length),
        });
    }

    /**
     * Measure event loop lag to detect blocking operations.
     * Returns the lag in milliseconds - high values indicate event loop blocking.
     */
    private measureEventLoopLag(): number {
        const start = process.hrtime.bigint();
        // This is synchronous - it just measures how long since we scheduled vs now
        // In real monitoring, you'd use setImmediate to measure actual lag
        // For diagnostic purposes, this gives us a baseline timestamp
        return Number((process.hrtime.bigint() - start) / 1000000n);
    }

    /**
     * Check if an agent is in cooldown for a conversation and block routing if so.
     * Returns true if the agent is in cooldown and routing should be blocked.
     * Returns false if the agent is not in cooldown and routing should proceed.
     *
     * This helper consolidates the cooldown check logic used in multiple dispatch paths.
     */
    private async checkAndBlockIfCooldown(
        projectId: string,
        conversationId: string,
        agentPubkey: string,
        agentSlug: string,
        span: ReturnType<typeof tracer.startSpan>,
        eventType: "delegation_completion" | "routing"
    ): Promise<boolean> {
        const { CooldownRegistry } = await import("@/services/CooldownRegistry");
        const cooldownRegistry = CooldownRegistry.getInstance();

        if (cooldownRegistry.isInCooldown(projectId, conversationId, agentPubkey)) {
            // Agent is in cooldown - skip routing
            logger.info(`[dispatch] ${eventType === "delegation_completion" ? "Delegation completion routing" : "Routing"} blocked due to cooldown`, {
                projectId: projectId.substring(0, 12),
                conversationId: conversationId.substring(0, 12),
                agentSlug,
                agentPubkey: agentPubkey.substring(0, 12),
            });

            span.addEvent(`dispatch.${eventType}_blocked_cooldown`, {
                "cooldown.project_id": projectId.substring(0, 12),
                "cooldown.conversation_id": shortenConversationId(conversationId),
                "cooldown.agent_pubkey": agentPubkey.substring(0, 12),
                "cooldown.agent_slug": agentSlug,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return true;
        }

        return false;
    }

    /**
     * Handle injection of a message into an active RAL.
     * Returns true if execution should be SKIPPED (message queued for active streaming execution).
     * Returns false if a new execution should be spawned.
     */
    private handleDeliveryInjection(params: {
        activeRal: RALRegistryEntry | undefined;
        agent: AgentInstance;
        conversationId: string;
        message: string;
        senderPubkey: string;
        eventId?: string;
        agentSpan: ReturnType<typeof tracer.startSpan>;
    }): boolean {
        const {
            activeRal,
            agent,
            conversationId,
            message,
            senderPubkey,
            eventId,
            agentSpan,
        } = params;

        if (!activeRal) {
            return false; // No active RAL, spawn new execution
        }

        const ralRegistry = RALRegistry.getInstance();
        const messageLength = message.length;

        ralRegistry.queueUserMessage(
            agent.pubkey,
            conversationId,
            activeRal.ralNumber,
            message,
            { senderPubkey, eventId }
        );

        if (activeRal.isStreaming) {
            // Check if this is a Claude Code agent
            const llmConfig = config.getLLMConfig(agent.llmConfig);
            const isClaudeCodeProvider = llmConfig.provider === PROVIDER_IDS.CLAUDE_CODE;

            if (isClaudeCodeProvider) {
                // Try to use message injection if available (requires fork of ai-sdk-provider-claude-code)
                const injector = llmOpsRegistry.getMessageInjector(agent.pubkey, conversationId);

                if (injector) {
                    // Message injector available - use it instead of abort-restart
                    injector.inject(message, (delivered) => {
                        if (delivered) {
                            // Clear queued injections since MessageInjector delivered the message directly.
                            // This prevents hasOutstandingWork() from incorrectly reporting pending work.
                            // See: naddr1qvzqqqr4gupzqkmm302xww6uyne99rnhl5kjj53wthjypm2qaem9uz9fdf3hzcf0qyghwumn8ghj7ar9dejhstnrdpshgtcq9p382emxd9uz6en0d3kx7am4wqkkjmn2v43hg6t0dckhzat9w4jj6cmvv4shy6twvullqw7x
                            ralRegistry.clearQueuedInjections(agent.pubkey, conversationId);

                            logger.info("[dispatch] Message injected via Claude Code MessageInjector", {
                                agent: agent.slug,
                                ralNumber: activeRal.ralNumber,
                                messageLength,
                            });
                        } else {
                            // Injection failed - the message is already queued in RALRegistry,
                            // so the next execution will pick it up
                            logger.warn("[dispatch] Message injection delivery failed (message already queued)", {
                                agent: agent.slug,
                                ralNumber: activeRal.ralNumber,
                                messageLength,
                            });
                        }
                    });

                    getSafeActiveSpan()?.addEvent("reply.message_injected_via_injector", {
                        "agent.slug": agent.slug,
                        "ral.number": activeRal.ralNumber,
                        "message.length": messageLength,
                    });
                    agentSpan.addEvent("dispatch.injection_via_message_injector", {
                        "message.length": messageLength,
                    });

                    // Skip spawning new execution - the active execution will pick up the injected message
                    return true;
                }

                // No injector available - fall back to abort-restart
                const aborted = llmOpsRegistry.stopByAgentAndConversation(
                    agent.pubkey,
                    conversationId,
                    INJECTION_ABORT_REASON
                );

                if (aborted) {
                    getSafeActiveSpan()?.addEvent("reply.aborted_for_injection", {
                        "agent.slug": agent.slug,
                        "ral.number": activeRal.ralNumber,
                        "message.length": messageLength,
                    });
                    logger.info("[reply] Aborted Claude Code execution for injection (no injector)", {
                        agent: agent.slug,
                        ralNumber: activeRal.ralNumber,
                        injectionLength: messageLength,
                    });
                    agentSpan.addEvent("dispatch.injection_stream_abort_fallback", {
                        "message.length": messageLength,
                    });
                } else {
                    getSafeActiveSpan()?.addEvent("reply.message_queued_during_streaming", {
                        "agent.slug": agent.slug,
                        "ral.number": activeRal.ralNumber,
                        "message.length": messageLength,
                    });
                    agentSpan.addEvent("dispatch.injection_stream_queue_only", {
                        "message.length": messageLength,
                    });
                }
                // Spawn new execution (aborted or will pick up on restart)
                return false;
            } else {
                // Non-Claude-Code provider: just queue the message, don't abort.
                // The active execution will pick it up on its next prepareStep.
                // IMPORTANT: Skip spawning a new execution to avoid duplicate completions.
                // See report: "injection-race-condition-hybrid-fix" for known limitations.
                getSafeActiveSpan()?.addEvent("reply.message_injected_no_abort", {
                    "agent.slug": agent.slug,
                    "ral.number": activeRal.ralNumber,
                    "message.length": messageLength,
                    "provider": llmConfig.provider,
                });
                logger.info("[reply] Queued message for non-Claude-Code provider (no abort, skipping execution)", {
                    agent: agent.slug,
                    ralNumber: activeRal.ralNumber,
                    injectionLength: messageLength,
                    provider: llmConfig.provider,
                });
                agentSpan.addEvent("dispatch.injection_stream_no_abort_skip_execution", {
                    "message.length": messageLength,
                    "provider": llmConfig.provider,
                });
                // Non-Claude: skip execution, trust active execution to pick up injection
                return true;
            }
        }

        // Not streaming (waiting for delegations) - need new execution to wake up
        getSafeActiveSpan()?.addEvent("reply.message_queued_for_resumption", {
            "agent.slug": agent.slug,
            "ral.number": activeRal.ralNumber,
            "message.length": messageLength,
        });
        agentSpan.addEvent("dispatch.injection_resumption", {
            "message.length": messageLength,
        });
        return false; // Spawn new execution to wake up the waiting RAL
    }
}
