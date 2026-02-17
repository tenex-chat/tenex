/**
 * AgentExecutor - Orchestrates agent execution with LLM streaming
 *
 * This is the main entry point for executing agent tasks. It coordinates:
 * - RAL (Request/Assignement/Loop) lifecycle management
 * - Stream setup and execution via extracted modules
 * - Post-completion supervision checks
 * - Event publishing
 *
 * The heavy lifting is delegated to:
 * - StreamSetup: Pre-stream configuration (tools, messages, injections)
 * - StreamExecutionHandler: LLM streaming with event processing
 * - PostCompletionChecker: Supervision heuristics
 * - RALResolver: RAL lifecycle resolution
 */

import { assertSupervisionHealth } from "@/agents/supervision";
import { checkPostCompletion } from "./PostCompletionChecker";
import { resolveRAL } from "./RALResolver";
import { ConversationStore } from "@/conversations/ConversationStore";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { formatAnyError } from "@/lib/error-formatter";
import { shortenConversationId } from "@/utils/conversation-id";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { INJECTION_ABORT_REASON } from "@/services/LLMOperationsRegistry";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { getPubkeyService } from "@/services/PubkeyService";
import { getToolsObject } from "@/tools/registry";
import type { ToolRegistryContext } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/services/event-context";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { ModelMessage } from "ai";
import { ToolExecutionTracker } from "./ToolExecutionTracker";
import { setupStreamExecution } from "./StreamSetup";
import { StreamExecutionHandler } from "./StreamExecutionHandler";
import type {
    ExecutionContext,
    FullRuntimeContext,
    LLMCompletionRequest,
    StandaloneAgentContext,
    StreamExecutionResult,
} from "./types";

const tracer = trace.getTracer("tenex.agent-executor");

export class AgentExecutor {
    constructor(private standaloneContext?: StandaloneAgentContext) {
        // Centralized supervision health check - ensures both total registry size AND
        // post-completion heuristic count are validated (fail-closed semantics)
        assertSupervisionHealth("AgentExecutor");
    }

    /**
     * Warm user profile cache for injection sender pubkeys (best-effort, non-blocking).
     */
    private warmSenderPubkeys(injections: Array<{ senderPubkey?: string }>): void {
        const senderPubkeys = injections
            .map((i) => i.senderPubkey)
            .filter((pk): pk is string => !!pk);

        if (senderPubkeys.length > 0) {
            const pubkeyService = getPubkeyService();
            void pubkeyService.warmUserProfiles(senderPubkeys).catch((error) => {
                logger.debug("[AgentExecutor] Best-effort profile warming failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
    }

    /**
     * Prepare an LLM request without executing it.
     * Creates stub context for tool schema extraction - runtime deps are never called.
     */
    async prepareLLMRequest(
        agent: { slug: string; tools?: string[] },
        initialPrompt: string,
        originalEvent: NDKEvent,
        conversationHistory: ModelMessage[] = [],
        projectPath?: string
    ): Promise<LLMCompletionRequest> {
        const context: ToolRegistryContext = {
            agent: agent as ToolRegistryContext["agent"],
            triggeringEvent: originalEvent,
            conversationId: originalEvent.id,
            projectBasePath: projectPath || this.standaloneContext?.project?.tagValue("d") || "",
            workingDirectory: projectPath || this.standaloneContext?.project?.tagValue("d") || "",
            currentBranch: "main",
            agentPublisher: {} as AgentPublisher,
            ralNumber: 0,
            conversationStore: {} as ConversationStore,
            getConversation: () => ({} as ConversationStore),
        };

        const messages: ModelMessage[] = conversationHistory.length > 0
            ? [...conversationHistory]
            : [{ role: "user", content: initialPrompt }];

        const toolNames = agent.tools || [];
        const tools = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

        return { messages, tools };
    }

    /**
     * Execute an agent's assignment for a conversation with streaming
     */
    async execute(context: ExecutionContext): Promise<NDKEvent | undefined> {
        const span = tracer.startSpan("tenex.agent.execute", {
            attributes: {
                "agent.slug": context.agent.slug,
                "agent.pubkey": context.agent.pubkey,
                "agent.role": context.agent.role || "worker",
                "conversation.id": shortenConversationId(context.conversationId),
                "triggering_event.id": context.triggeringEvent.id,
                "triggering_event.kind": context.triggeringEvent.kind || 0,
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                // Get project ID for multi-project isolation in daemon mode
                const projectCtx = getProjectContext();
                const projectId = projectCtx.project.tagId();

                const { ralNumber, isResumption, markersToPublish } = await resolveRAL({
                    agentPubkey: context.agent.pubkey,
                    conversationId: context.conversationId,
                    projectId,
                    triggeringEventId: context.triggeringEvent.id,
                    span,
                });

                // RACE CONDITION FIX: Early kill check
                // If this conversation was killed before the agent started (or during RAL resolution),
                // abort immediately without spending compute resources.
                const ralRegistry = RALRegistry.getInstance();
                if (ralRegistry.isAgentConversationKilled(context.agent.pubkey, context.conversationId)) {
                    span.addEvent("executor.aborted_early_kill", {
                        "ral.number": ralNumber,
                        "agent.pubkey": context.agent.pubkey.substring(0, 12),
                        "conversation.id": shortenConversationId(context.conversationId),
                    });

                    logger.info("[AgentExecutor] Execution aborted - conversation was killed before agent started", {
                        agent: context.agent.slug,
                        conversationId: shortenConversationId(context.conversationId),
                        ralNumber,
                    });

                    // Clean up the RAL we just created since we're not going to use it
                    ralRegistry.clear(context.agent.pubkey, context.conversationId);

                    span.setStatus({ code: SpanStatusCode.OK, message: "aborted_early_kill" });
                    return undefined;
                }

                const contextWithRal = { ...context, ralNumber };
                const { fullContext, toolTracker, agentPublisher, cleanup } =
                    this.prepareExecution(contextWithRal);

                // Publish delegation marker updates to Nostr
                // This happens after RAL resolution when delegations have completed
                if (markersToPublish && markersToPublish.length > 0) {
                    span.addEvent("executor.publishing_delegation_markers", {
                        "marker.count": markersToPublish.length,
                    });

                    for (const marker of markersToPublish) {
                        try {
                            await agentPublisher.delegationMarker(marker);
                        } catch (error) {
                            logger.warn("Failed to publish delegation marker", {
                                delegationConversationId: marker.delegationConversationId.substring(0, 12),
                                status: marker.status,
                                error: formatAnyError(error),
                            });
                        }
                    }
                }

                const conversation = fullContext.getConversation();
                if (conversation) {
                    span.setAttributes({
                        "conversation.message_count": conversation.getMessageCount(),
                    });
                }

                span.addEvent("executor.started", {
                    ral_number: ralNumber,
                    is_resumption: isResumption,
                });

                try {
                    const result = await this.executeOnce(
                        fullContext,
                        toolTracker,
                        agentPublisher,
                        ralNumber
                    );

                    span.setStatus({ code: SpanStatusCode.OK });
                    return result;
                } finally {
                    await cleanup();
                }
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });

                const errorMessage = formatAnyError(error);
                const isCreditsError =
                    errorMessage.includes("Insufficient credits") || errorMessage.includes("402");

                const displayMessage = isCreditsError
                    ? "Unable to process your request: Insufficient credits. Please add more credits at https://openrouter.ai/settings/credits to continue."
                    : `Unable to process your request due to an error: ${errorMessage}`;

                const conversation = context.getConversation();
                if (conversation) {
                    const agentPublisher = new AgentPublisher(context.agent);
                    try {
                        await agentPublisher.error(
                            {
                                message: displayMessage,
                                errorType: isCreditsError ? "insufficient_credits" : "execution_error",
                            },
                            {
                                triggeringEvent: context.triggeringEvent,
                                rootEvent: { id: conversation.getRootEventId() },
                                conversationId: conversation.id,
                                ralNumber: 0,
                            }
                        );
                    } catch (publishError) {
                        logger.error("Failed to publish execution error event", {
                            error: formatAnyError(publishError),
                        });
                    }
                }

                logger.error(
                    isCreditsError
                        ? "[AgentExecutor] Execution failed due to insufficient credits"
                        : "[AgentExecutor] Execution failed",
                    {
                        agent: context.agent.slug,
                        error: errorMessage,
                        conversationId: context.conversationId,
                    }
                );

                throw error;
            } finally {
                span.end();
            }
        });
    }

    /**
     * Prepare execution context with all necessary components.
     */
    private prepareExecution(
        context: ExecutionContext & { ralNumber: number }
    ): {
        fullContext: FullRuntimeContext;
        toolTracker: ToolExecutionTracker;
        agentPublisher: AgentPublisher;
        cleanup: () => Promise<void>;
    } {
        const toolTracker = new ToolExecutionTracker();
        const agentPublisher = new AgentPublisher(context.agent);
        const conversationStore = ConversationStore.getOrLoad(context.conversationId);
        const projectContext = getProjectContext();

        const fullContext: FullRuntimeContext = {
            agent: context.agent,
            conversationId: context.conversationId,
            projectBasePath: context.projectBasePath,
            workingDirectory: context.workingDirectory,
            currentBranch: context.currentBranch,
            triggeringEvent: context.triggeringEvent,
            agentPublisher,
            ralNumber: context.ralNumber,
            conversationStore,
            getConversation: () => conversationStore,
            alphaMode: context.alphaMode,
            mcpManager: projectContext.mcpManager,
            isDelegationCompletion: context.isDelegationCompletion,
            hasPendingDelegations: context.hasPendingDelegations,
        };

        const conversation = fullContext.getConversation();
        startExecutionTime(conversation);

        const cleanup = async (): Promise<void> => {
            stopExecutionTime(conversation);
            toolTracker.clear();
        };

        return { fullContext, toolTracker, agentPublisher, cleanup };
    }

    /**
     * Execute streaming and publish result
     */
    private async executeOnce(
        context: FullRuntimeContext,
        toolTracker: ToolExecutionTracker,
        agentPublisher: AgentPublisher,
        ralNumber: number
    ): Promise<NDKEvent | undefined> {
        let result: StreamExecutionResult;

        try {
            result = await this.executeStreaming(context, toolTracker, ralNumber);
        } catch (streamError) {
            logger.error("[AgentExecutor] Streaming failed", {
                agent: context.agent.slug,
                error: formatAnyError(streamError),
            });
            throw streamError;
        }

        if (result.kind === "error-handled") {
            return undefined;
        }

        if (result.aborted) {
            if (result.abortReason === INJECTION_ABORT_REASON) {
                trace.getActiveSpan()?.addEvent("executor.aborted_for_injection", {
                    "ral.number": ralNumber,
                    "agent.slug": context.agent.slug,
                });
                logger.info("[AgentExecutor] Execution aborted for injection - silent return", {
                    agent: context.agent.slug,
                    ralNumber,
                });
                return undefined;
            }

            const eventContext = createEventContext(context);
            const responseEvent = await agentPublisher.complete(
                { content: "Manually stopped by user" },
                eventContext
            );
            // Handle case where completion was skipped (conversation was killed)
            if (responseEvent) {
                await ConversationStore.addEvent(context.conversationId, responseEvent);
            }
            return responseEvent;
        }

        const completionEvent = result.event;
        const ralRegistry = RALRegistry.getInstance();

        // =====================================================================
        // RACE CONDITION FIX: Check for ANY outstanding work, not just pending delegations
        // =====================================================================
        // This is the key guard against the race condition where delegation results arrive
        // (via debounce in AgentDispatchService) after the last prepareStep but before
        // the executor finalizes. The debounce state queues injections that would be
        // invisible if we only checked pendingDelegations.
        //
        // hasOutstandingWork() consolidates checking for:
        // 1. Queued injections (messages/delegation results waiting for next LLM step)
        // 2. Pending delegations (delegations that haven't completed yet)
        // =====================================================================
        const outstandingWork = ralRegistry.hasOutstandingWork(
            context.agent.pubkey,
            context.conversationId,
            ralNumber
        );

        // NOTE: startedWithPendingDelegations is a snapshot from dispatch time, used ONLY for
        // conservative RAL lifetime management (line ~395). It should NOT be used for the publish
        // mode decision because delegations may have completed during execution.
        const startedWithPendingDelegations = Boolean(
            context.isDelegationCompletion && context.hasPendingDelegations
        );

        // DIAGNOSTIC: Trace the exact values used in outstanding work decision
        trace.getActiveSpan()?.addEvent("executor.outstanding_work_decision", {
            "context.isDelegationCompletion": context.isDelegationCompletion ?? false,
            "context.hasPendingDelegations_snapshot": context.hasPendingDelegations ?? false,
            "startedWithPendingDelegations_for_ral_cleanup": startedWithPendingDelegations,
            "outstanding.has_work": outstandingWork.hasWork,
            "outstanding.queued_injections": outstandingWork.details.queuedInjections,
            "outstanding.pending_delegations": outstandingWork.details.pendingDelegations,
            "fix_applied": "uses hasOutstandingWork() to check both injections and delegations",
        });

        // INVARIANT GUARD: If there's outstanding work (queued injections OR pending delegations),
        // we should NOT finalize. The executor should continue to allow the work to be processed.
        const hasMessageContent = completionEvent?.message && completionEvent.message.length > 0;
        if (!hasMessageContent && outstandingWork.hasWork) {
            // This is the expected path when delegation results arrive via debounce.
            // The executor returns undefined to allow the dispatch loop to continue
            // and process the queued injections in the next iteration.
            trace.getActiveSpan()?.addEvent("executor.awaiting_outstanding_work", {
                "ral.number": ralNumber,
                "outstanding.queued_injections": outstandingWork.details.queuedInjections,
                "outstanding.pending_delegations": outstandingWork.details.pendingDelegations,
                "completion_event_exists": Boolean(completionEvent),
                "scenario": "injection_debounce_await",
            });
            logger.debug("[AgentExecutor] Deferring finalization due to outstanding work", {
                agent: context.agent.slug,
                ralNumber,
                queuedInjections: outstandingWork.details.queuedInjections,
                pendingDelegations: outstandingWork.details.pendingDelegations,
            });
            return undefined;
        }

        if (!completionEvent) {
            // This is an unexpected state: no completion event AND no outstanding work.
            // The LLM stream should always produce a completion event if it completes normally.
            // Log extensively before throwing to aid debugging.
            logger.error("[AgentExecutor] Missing completion event with no outstanding work", {
                agent: context.agent.slug,
                ralNumber,
                conversationId: context.conversationId.substring(0, 12),
                hasOutstandingWork: outstandingWork.hasWork,
            });
            trace.getActiveSpan()?.addEvent("executor.missing_completion_event_error", {
                "ral.number": ralNumber,
                "outstanding.has_work": outstandingWork.hasWork,
                "scenario": "unexpected_missing_completion",
            });
            throw new Error("LLM execution completed without producing a completion event");
        }

        // Post-completion supervision check
        const supervisionCheckResult = await checkPostCompletion({
            agent: context.agent,
            context,
            conversationStore: context.conversationStore,
            ralNumber,
            completionEvent,
        });

        if (supervisionCheckResult.shouldReEngage) {
            return this.executeOnce(context, toolTracker, agentPublisher, ralNumber);
        }

        // RAL cleanup - use hasOutstandingWork for comprehensive check
        const conversationStore = context.conversationStore;
        const cleanupOutstandingWork = ralRegistry.hasOutstandingWork(
            context.agent.pubkey,
            context.conversationId,
            ralNumber
        );

        if (!cleanupOutstandingWork.hasWork && !startedWithPendingDelegations) {
            ralRegistry.clearRAL(context.agent.pubkey, context.conversationId, ralNumber);
            conversationStore.completeRal(context.agent.pubkey, ralNumber);
            await conversationStore.save();

            trace.getActiveSpan()?.addEvent("executor.ral_cleared_post_supervision_check", {
                "ral.number": ralNumber,
                "supervision.executed": true,
                "supervision.had_violation": supervisionCheckResult.shouldReEngage,
            });
        } else if (!cleanupOutstandingWork.hasWork && startedWithPendingDelegations) {
            trace.getActiveSpan()?.addEvent("executor.ral_clear_skipped_pending_at_start", {
                "ral.number": ralNumber,
                "supervision.executed": true,
            });
        }

        const eventContext = createEventContext(context, {
            model: completionEvent?.usage?.model,
        });

        // Re-check outstanding work for final publish decision (state may have changed after supervision)
        const finalOutstandingWork = ralRegistry.hasOutstandingWork(
            context.agent.pubkey,
            context.conversationId,
            ralNumber
        );

        trace.getActiveSpan()?.addEvent("executor.publish", {
            "message.length": completionEvent?.message?.length || 0,
            "outstanding.has_work": finalOutstandingWork.hasWork,
            "outstanding.queued_injections": finalOutstandingWork.details.queuedInjections,
            "outstanding.pending_delegations": finalOutstandingWork.details.pendingDelegations,
        });

        let responseEvent: NDKEvent | undefined;

        if (finalOutstandingWork.hasWork) {
            // If there's outstanding work, publish as conversation (not completion)
            if (completionEvent.message.trim().length > 0) {
                responseEvent = await agentPublisher.conversation(
                    { content: completionEvent.message, usage: completionEvent.usage },
                    eventContext
                );
            }
        } else {
            // No outstanding work - safe to publish as complete
            responseEvent = await agentPublisher.complete(
                { content: completionEvent.message, usage: completionEvent.usage },
                eventContext
            );
        }

        if (responseEvent) {
            await ConversationStore.addEvent(context.conversationId, responseEvent);

            trace.getActiveSpan()?.addEvent("executor.published", {
                "event.id": responseEvent.id || "",
                is_completion: !finalOutstandingWork.hasWork,
            });

            result.messageCompiler.advanceCursor();
        }

        return responseEvent;
    }

    /**
     * Execute streaming and return the result.
     * Delegates to StreamSetup for configuration and StreamExecutionHandler for execution.
     */
    private async executeStreaming(
        context: FullRuntimeContext,
        toolTracker: ToolExecutionTracker,
        ralNumber: number
    ): Promise<StreamExecutionResult> {
        // Setup stream execution (tools, messages, injections, meta model)
        const setup = await setupStreamExecution(
            context,
            toolTracker,
            ralNumber,
            { warmSenderPubkeys: this.warmSenderPubkeys.bind(this) }
        );

        // Create and execute stream handler
        const handler = new StreamExecutionHandler({
            context,
            toolTracker,
            ralNumber,
            toolsObject: setup.toolsObject,
            sessionManager: setup.sessionManager,
            llmService: setup.llmService,
            messageCompiler: setup.messageCompiler,
            nudgeContent: setup.nudgeContent,
            ephemeralMessages: setup.ephemeralMessages,
            abortSignal: setup.abortSignal,
            metaModelSystemPrompt: setup.metaModelSystemPrompt,
            variantSystemPrompt: setup.variantSystemPrompt,
            compressionLlmService: setup.compressionLlmService,
        });

        return handler.execute(setup.messages);
    }
}
