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
import type {
    AgentRuntimePublisher,
    PublishedMessageRef,
} from "@/events/runtime/AgentRuntimePublisher";
import type { AgentRuntimePublisherFactory } from "@/events/runtime/AgentRuntimePublisherFactory";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { formatAnyError } from "@/lib/error-formatter";
import {
    createTenexSystemReminderContext,
    runWithSystemReminderContext,
} from "@/llm/system-reminder-context";
import { shortenConversationId, shortenOptionalConversationId, shortenPubkey } from "@/utils/conversation-id";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";
import { INJECTION_ABORT_REASON } from "@/services/LLMOperationsRegistry";
import { InterventionService } from "@/services/intervention";
import { getProjectContext } from "@/services/projects";
import { createProjectDTag } from "@/types/project-ids";
import { RALRegistry } from "@/services/ral";
import { getIdentityService } from "@/services/identity";
import { getToolsObject } from "@/tools/registry";
import type { ToolRegistryContext } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/services/event-context";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { ModelMessage } from "ai";
import { ToolExecutionTracker } from "./ToolExecutionTracker";
import { didEstablishPromptCacheFromUsage } from "./prompt-cache";
import { setupStreamExecution } from "./StreamSetup";
import { StreamExecutionHandler } from "./StreamExecutionHandler";
import type {
    ExecutionContext,
    FullRuntimeContext,
    LLMCompletionRequest,
    StreamExecutionResult,
} from "./types";

const tracer = trace.getTracer("tenex.agent-executor");

interface AgentExecutorOptions {
    publisherFactory?: AgentRuntimePublisherFactory;
}

function failSchemaOnlyAccess(methodName: string): never {
    throw new Error(`${methodName}() called in schema-only context`);
}

function createSchemaOnlyPublisher(): AgentRuntimePublisher {
    return {
        complete: async () => failSchemaOnlyAccess("agentPublisher.complete"),
        conversation: async () => failSchemaOnlyAccess("agentPublisher.conversation"),
        delegate: async () => failSchemaOnlyAccess("agentPublisher.delegate"),
        ask: async () => failSchemaOnlyAccess("agentPublisher.ask"),
        delegateFollowup: async () => failSchemaOnlyAccess("agentPublisher.delegateFollowup"),
        error: async () => failSchemaOnlyAccess("agentPublisher.error"),
        lesson: async () => failSchemaOnlyAccess("agentPublisher.lesson"),
        toolUse: async () => failSchemaOnlyAccess("agentPublisher.toolUse"),
        streamTextDelta: async () => failSchemaOnlyAccess("agentPublisher.streamTextDelta"),
    };
}

export class AgentExecutor {
    private readonly publisherFactory: AgentRuntimePublisherFactory;

    constructor(options: AgentExecutorOptions = {}) {
        // Centralized supervision health check - ensures both total registry size AND
        // post-completion heuristic count are validated (fail-closed semantics)
        assertSupervisionHealth("AgentExecutor");
        if (!options.publisherFactory) {
            throw new Error(
                "AgentExecutor requires a publisherFactory. Direct TypeScript Nostr publishing is disabled; Rust must inject the publish bridge."
            );
        }
        this.publisherFactory = options.publisherFactory;
    }

    /**
     * Start the intervention timer only at the semantic final-completion seam:
     * after the executor has decided there is no outstanding work and has
     * successfully published a `complete()` event to the root human user.
     */
    private async notifyInterventionOfFinalCompletion(
        context: FullRuntimeContext,
        responseEvent: PublishedMessageRef
    ): Promise<void> {
        const interventionService = InterventionService.getInstance();
        if (!interventionService.isEnabled()) {
            return;
        }

        const rootAuthorPubkey = context.conversationStore.getRootAuthorPubkey();
        if (!rootAuthorPubkey) {
            return;
        }

        const recipientPubkeys = responseEvent.envelope.recipients
            .map((recipient) => recipient.linkedPubkey)
            .filter((pubkey): pubkey is string => !!pubkey);

        if (!recipientPubkeys.includes(rootAuthorPubkey)) {
            return;
        }

        const dTagValue = context.projectContext.project.tagValue("d");
        if (!dTagValue) {
            logger.warn("[AgentExecutor] Cannot start intervention timer - project missing d-tag", {
                agent: context.agent.slug,
                conversationId: shortenConversationId(context.conversationId),
            });
            return;
        }

        const projectId = createProjectDTag(dTagValue);

        try {
            await interventionService.setProject(projectId);
        } catch (error) {
            logger.error("[AgentExecutor] Failed to set intervention project context", {
                projectId: projectId.substring(0, 12),
                conversationId: shortenConversationId(context.conversationId),
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }

        interventionService.onAgentCompletion(
            context.conversationId,
            responseEvent.envelope.occurredAt * 1000,
            context.agent.pubkey,
            rootAuthorPubkey,
            projectId
        );
    }

    /**
     * Warm user profile cache for injection sender pubkeys (best-effort, non-blocking).
     */
    private warmSenderPubkeys(injections: Array<{ senderPubkey?: string }>): void {
        const senderPubkeys = injections
            .map((i) => i.senderPubkey)
            .filter((pk): pk is string => !!pk);

        if (senderPubkeys.length > 0) {
            const identityService = getIdentityService();
            void identityService.warmUserProfiles(senderPubkeys).catch((error) => {
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
        const triggeringEnvelope = new NostrInboundAdapter().toEnvelope(originalEvent);
        const projectContext = getProjectContext();
        const context: ToolRegistryContext = {
            agent: agent as ToolRegistryContext["agent"],
            triggeringEnvelope,
            conversationId: originalEvent.id,
            projectBasePath: projectPath || "",
            workingDirectory: projectPath || "",
            currentBranch: "main",
            agentPublisher: createSchemaOnlyPublisher(),
            ralNumber: 0,
            projectContext,
            conversationStore: new Proxy({} as ConversationStore, {
                get: (_, prop) => { throw new Error(`conversationStore.${String(prop)} called in schema-only context`); },
            }),
            getConversation: () => { throw new Error("getConversation() called in schema-only context"); },
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
    async execute(context: ExecutionContext): Promise<PublishedMessageRef | undefined> {
        const telegramMetadata = context.triggeringEnvelope.metadata.transport?.telegram;
        const span = tracer.startSpan("tenex.agent.execute", {
            attributes: {
                "agent.slug": context.agent.slug,
                "agent.pubkey": context.agent.pubkey,
                "agent.role": context.agent.role || "worker",
                "conversation.id": shortenConversationId(context.conversationId),
                "triggering_event.id": context.triggeringEnvelope.message.nativeId,
                "triggering_event.kind": context.triggeringEnvelope.metadata.eventKind || 0,
                "triggering_event.transport": context.triggeringEnvelope.transport,
                "telegram.update.id": telegramMetadata?.updateId ?? 0,
                "telegram.chat.id": telegramMetadata?.chatId ?? "",
                "telegram.message.id": telegramMetadata?.messageId ?? "",
                "telegram.chat.thread_id": telegramMetadata?.threadId ?? "",
                "telegram.sender.id": telegramMetadata?.senderUserId ?? "",
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () =>
            runWithSystemReminderContext(async () => {
                try {
                    // Get project ID for multi-project isolation in daemon mode
                    const projectCtx = getProjectContext();
                    const dTagValue = projectCtx.project.tagValue("d");
                    if (!dTagValue) {
                        throw new Error("Project missing d-tag");
                    }
                    const projectId = createProjectDTag(dTagValue);

                    const { ralNumber, isResumption } = await resolveRAL({
                        agentPubkey: context.agent.pubkey,
                        conversationId: context.conversationId,
                        projectId,
                        triggeringEventId: context.triggeringEnvelope.message.nativeId,
                        span,
                        preferredRalNumber: context.preferredRalNumber,
                    });

                    // Abort before publisher/setup work if the conversation was killed during RAL resolution.
                    const ralRegistry = RALRegistry.getInstance();
                    if (ralRegistry.isAgentConversationKilled(context.agent.pubkey, context.conversationId)) {
                        span.addEvent("executor.aborted_early_kill", {
                            "ral.number": ralNumber,
                            "agent.pubkey": shortenPubkey(context.agent.pubkey),
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
                            ralNumber,
                            context.preferredRalClaimToken
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
                        const agentPublisher = this.publisherFactory(context.agent);
                        try {
                            await agentPublisher.error(
                                {
                                    message: displayMessage,
                                    errorType: isCreditsError ? "insufficient_credits" : "execution_error",
                                },
                                {
                                    triggeringEnvelope: context.triggeringEnvelope,
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

                    logger.writeToWarnLog({
                        timestamp: new Date().toISOString(),
                        level: "error",
                        component: "AgentExecutor",
                        message: isCreditsError
                            ? "Execution failed due to insufficient credits"
                            : "Agent execution failed",
                        context: {
                            agentSlug: context.agent.slug,
                            conversationId: shortenOptionalConversationId(conversation?.id),
                            isCreditsError,
                            errorType: isCreditsError ? "insufficient_credits" : "execution_error",
                        },
                        error: errorMessage,
                        stack: error instanceof Error ? error.stack : undefined,
                    });

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
            }, createTenexSystemReminderContext())
        );
    }

    /**
     * Prepare execution context with all necessary components.
     */
    private prepareExecution(
        context: ExecutionContext & { ralNumber: number }
    ): {
        fullContext: FullRuntimeContext;
        toolTracker: ToolExecutionTracker;
        agentPublisher: AgentRuntimePublisher;
        cleanup: () => Promise<void>;
    } {
        const toolTracker = new ToolExecutionTracker();
        const agentPublisher = this.publisherFactory(context.agent);
        const conversationStore = ConversationStore.getOrLoad(context.conversationId);
        const projectContext = getProjectContext();

        logger.debug("[AgentExecutor] Created runtime publisher", {
            agent: context.agent.slug,
            conversationId: shortenConversationId(context.conversationId),
            publisherImplementation: agentPublisher.constructor?.name ?? "unknown",
        });
        trace.getActiveSpan()?.addEvent("runtime.publisher_created", {
            "agent.slug": context.agent.slug,
            "conversation.id": shortenConversationId(context.conversationId),
            "publisher.implementation": agentPublisher.constructor?.name ?? "unknown",
        });

        const fullContext: FullRuntimeContext = {
            agent: context.agent,
            conversationId: context.conversationId,
            projectBasePath: context.projectBasePath,
            workingDirectory: context.workingDirectory,
            currentBranch: context.currentBranch,
            triggeringEnvelope: context.triggeringEnvelope,
            agentPublisher,
            ralNumber: context.ralNumber,
            conversationStore,
            getConversation: () => conversationStore,
            projectContext,
            mcpManager: context.mcpManager,
            agentExecutor: this,
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
     * Execute streaming and publish result.
     *
     * `resumptionClaimToken` is consumed only on the FIRST invocation. On
     * supervision re-engagement (the recursive call at the end of this
     * method), the claim has already been handed off by StreamExecutionHandler
     * on the first pass, so we pass undefined to avoid a stale-token no-op.
     */
    private async executeOnce(
        context: FullRuntimeContext,
        toolTracker: ToolExecutionTracker,
        agentPublisher: AgentRuntimePublisher,
        ralNumber: number,
        resumptionClaimToken?: string
    ): Promise<PublishedMessageRef | undefined> {
        let result: StreamExecutionResult;

        try {
            result = await this.executeStreaming(context, toolTracker, ralNumber, resumptionClaimToken);
        } catch (streamError) {
            logger.error("[AgentExecutor] Streaming failed", {
                agent: context.agent.slug,
                error: formatAnyError(streamError),
            });
            logger.writeToWarnLog({
                timestamp: new Date().toISOString(),
                level: "error",
                component: "AgentExecutor",
                message: "LLM streaming execution failed",
                context: {
                    agentSlug: context.agent.slug,
                    ralNumber,
                },
                error: formatAnyError(streamError),
                stack: streamError instanceof Error ? streamError.stack : undefined,
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
                await ConversationStore.addEnvelope(context.conversationId, responseEvent.envelope);
            }
            return responseEvent;
        }

        const completionEvent = result.event;
        const ralRegistry = RALRegistry.getInstance();
        const silentCompletionRequested = ralRegistry.isSilentCompletionRequested(
            context.agent.pubkey,
            context.conversationId,
            ralNumber
        );

        // Final publish/cleanup decisions must consider both queued injections and pending delegations.
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
            "outstanding.completed_delegations": outstandingWork.details.completedDelegations,
        });

        // INVARIANT GUARD: If there's outstanding work (queued injections, pending delegations,
        // or completed delegations not yet consumed), we should NOT finalize.
        const trimmedCompletionMessage = completionEvent?.message?.trim() ?? "";
        const hasMessageContent = trimmedCompletionMessage.length > 0;
        if (!hasMessageContent && outstandingWork.hasWork) {
            if (silentCompletionRequested) {
                ralRegistry.clearSilentCompletionRequest(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );
                trace.getActiveSpan()?.addEvent("executor.silent_completion_cleared_outstanding_work", {
                    "ral.number": ralNumber,
                    "agent.slug": context.agent.slug,
                    "conversation.id": shortenConversationId(context.conversationId),
                });
            }
            trace.getActiveSpan()?.addEvent("executor.awaiting_outstanding_work", {
                "ral.number": ralNumber,
                "outstanding.queued_injections": outstandingWork.details.queuedInjections,
                "outstanding.pending_delegations": outstandingWork.details.pendingDelegations,
                "outstanding.completed_delegations": outstandingWork.details.completedDelegations,
                "completion_event_exists": Boolean(completionEvent),
                "scenario": "injection_debounce_await",
            });
            logger.debug("[AgentExecutor] Deferring finalization due to outstanding work", {
                agent: context.agent.slug,
                ralNumber,
                queuedInjections: outstandingWork.details.queuedInjections,
                pendingDelegations: outstandingWork.details.pendingDelegations,
                completedDelegations: outstandingWork.details.completedDelegations,
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
                conversationId: shortenConversationId(context.conversationId),
                hasOutstandingWork: outstandingWork.hasWork,
            });
            trace.getActiveSpan()?.addEvent("executor.missing_completion_event_error", {
                "ral.number": ralNumber,
                "outstanding.has_work": outstandingWork.hasWork,
                "scenario": "unexpected_missing_completion",
            });
            throw new Error("LLM execution completed without producing a completion event");
        }

        if (silentCompletionRequested && trimmedCompletionMessage.length === 0) {
            ralRegistry.clearSilentCompletionRequest(
                context.agent.pubkey,
                context.conversationId,
                ralNumber
            );

            await this.cleanupRalAfterTurn({
                context,
                ralNumber,
                startedWithPendingDelegations,
                supervisionExecuted: false,
                supervisionHadViolation: false,
            });

            trace.getActiveSpan()?.addEvent("executor.silent_completion_honored", {
                "ral.number": ralNumber,
                "agent.slug": context.agent.slug,
                "conversation.id": shortenConversationId(context.conversationId),
            });
            logger.info("[AgentExecutor] Honored explicit silent completion", {
                agent: context.agent.slug,
                conversationId: shortenConversationId(context.conversationId),
                ralNumber,
            });
            return undefined;
        }

        if (silentCompletionRequested && trimmedCompletionMessage.length > 0) {
            ralRegistry.clearSilentCompletionRequest(
                context.agent.pubkey,
                context.conversationId,
                ralNumber
            );
            trace.getActiveSpan()?.addEvent("executor.silent_completion_conflict", {
                "ral.number": ralNumber,
                "agent.slug": context.agent.slug,
                "conversation.id": shortenConversationId(context.conversationId),
                "message.length": completionEvent.message.length,
            });
            logger.info("[AgentExecutor] Ignoring silent completion request because visible text was produced", {
                agent: context.agent.slug,
                conversationId: shortenConversationId(context.conversationId),
                ralNumber,
                messageLength: completionEvent.message.length,
            });
        }

        const cacheAnchorEstablished = didEstablishPromptCacheFromUsage(completionEvent.usage)
            ? context.conversationStore.markAgentPromptHistoryCacheAnchored(context.agent.pubkey)
            : false;
        if (cacheAnchorEstablished) {
            await context.conversationStore.save();
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

        await this.cleanupRalAfterTurn({
            context,
            ralNumber,
            startedWithPendingDelegations,
            supervisionExecuted: true,
            supervisionHadViolation: supervisionCheckResult.shouldReEngage,
        });

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
            "outstanding.completed_delegations": finalOutstandingWork.details.completedDelegations,
        });

        let responseEvent: PublishedMessageRef | undefined;

        if (finalOutstandingWork.hasWork) {
            // If there's outstanding work, publish as conversation (not completion)
            if (trimmedCompletionMessage.length > 0) {
                responseEvent = await agentPublisher.conversation(
                    {
                        content: completionEvent.message,
                        usage: completionEvent.usage,
                        metadata: completionEvent.metadata,
                    },
                    eventContext
                );
            }
        } else {
            // No outstanding work - safe to publish as complete
            responseEvent = await agentPublisher.complete(
                {
                    content: completionEvent.message,
                    usage: completionEvent.usage,
                    metadata: completionEvent.metadata,
                },
                eventContext
            );
        }

        if (responseEvent) {
            if (!finalOutstandingWork.hasWork) {
                await this.notifyInterventionOfFinalCompletion(context, responseEvent);
            }

            await ConversationStore.addEnvelope(context.conversationId, responseEvent.envelope);

            trace.getActiveSpan()?.addEvent("executor.published", {
                "event.id": responseEvent.id || "",
                is_completion: !finalOutstandingWork.hasWork,
            });
        }

        return responseEvent;
    }

    private async cleanupRalAfterTurn(params: {
        context: FullRuntimeContext;
        ralNumber: number;
        startedWithPendingDelegations: boolean;
        supervisionExecuted: boolean;
        supervisionHadViolation: boolean;
    }): Promise<void> {
        const { context, ralNumber, startedWithPendingDelegations, supervisionExecuted, supervisionHadViolation } =
            params;
        const ralRegistry = RALRegistry.getInstance();
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

            trace.getActiveSpan()?.addEvent(
                supervisionExecuted
                    ? "executor.ral_cleared_post_supervision_check"
                    : "executor.ral_cleared_without_supervision",
                {
                    "ral.number": ralNumber,
                    "supervision.executed": supervisionExecuted,
                    "supervision.had_violation": supervisionHadViolation,
                }
            );
        } else if (!cleanupOutstandingWork.hasWork && startedWithPendingDelegations) {
            trace.getActiveSpan()?.addEvent(
                supervisionExecuted
                    ? "executor.ral_clear_skipped_pending_at_start"
                    : "executor.ral_clear_skipped_pending_at_start_without_supervision",
                {
                    "ral.number": ralNumber,
                    "supervision.executed": supervisionExecuted,
                }
            );
        }
    }

    /**
     * Execute streaming and return the result.
     * Delegates to StreamSetup for configuration and StreamExecutionHandler for execution.
     */
    private async executeStreaming(
        context: FullRuntimeContext,
        toolTracker: ToolExecutionTracker,
        ralNumber: number,
        resumptionClaimToken?: string
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
            llmService: setup.llmService,
            messageCompiler: setup.messageCompiler,
            request: setup.request,
            contextManagement: setup.contextManagement,
            skillToolPermissions: setup.skillToolPermissions,
            abortSignal: setup.abortSignal,
            metaModelSystemPrompt: setup.metaModelSystemPrompt,
            variantSystemPrompt: setup.variantSystemPrompt,
            resumptionClaimToken,
        });

        return handler.execute();
    }
}
