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

import { registerDefaultHeuristics } from "@/agents/supervision";
import { checkPostCompletion } from "./PostCompletionChecker";
import { resolveRAL } from "./RALResolver";
import { ConversationStore } from "@/conversations/ConversationStore";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { formatAnyError } from "@/lib/error-formatter";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { INJECTION_ABORT_REASON } from "@/services/LLMOperationsRegistry";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { getPubkeyService } from "@/services/PubkeyService";
import { getToolsObject } from "@/tools/registry";
import type { ToolRegistryContext } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/event-context";
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
        // Initialize supervision heuristics
        registerDefaultHeuristics();
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

        let messages: ModelMessage[] = [];

        if (conversationHistory.length > 0) {
            messages = [...conversationHistory];
        } else {
            messages = [{ role: "user", content: initialPrompt }];
        }

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
                "conversation.id": context.conversationId,
                "triggering_event.id": context.triggeringEvent.id,
                "triggering_event.kind": context.triggeringEvent.kind || 0,
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                const { ralNumber, isResumption } = await resolveRAL({
                    agentPubkey: context.agent.pubkey,
                    conversationId: context.conversationId,
                    triggeringEventId: context.triggeringEvent.id,
                    span,
                });

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
            await ConversationStore.addEvent(context.conversationId, responseEvent);
            return responseEvent;
        }

        const completionEvent = result.event;
        const ralRegistry = RALRegistry.getInstance();

        const currentPendingDelegations = ralRegistry.getConversationPendingDelegations(
            context.agent.pubkey,
            context.conversationId,
            ralNumber
        );

        const startedWithPendingDelegations = Boolean(
            context.isDelegationCompletion && context.hasPendingDelegations
        );
        const hasPendingDelegations = startedWithPendingDelegations || currentPendingDelegations.length > 0;

        const hasMessageContent = completionEvent?.message && completionEvent.message.length > 0;
        if (!hasMessageContent && hasPendingDelegations) {
            trace.getActiveSpan()?.addEvent("executor.awaiting_delegations", {
                "ral.number": ralNumber,
                "delegation.pending_count": currentPendingDelegations.length,
            });
            return undefined;
        }

        if (!completionEvent) {
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

        // RAL cleanup
        const conversationStore = context.conversationStore;
        const finalPendingDelegationsForCleanup = ralRegistry.getConversationPendingDelegations(
            context.agent.pubkey,
            context.conversationId,
            ralNumber
        );

        if (finalPendingDelegationsForCleanup.length === 0 && !startedWithPendingDelegations) {
            ralRegistry.clearRAL(context.agent.pubkey, context.conversationId, ralNumber);
            conversationStore.completeRal(context.agent.pubkey, ralNumber);
            await conversationStore.save();

            trace.getActiveSpan()?.addEvent("executor.ral_cleared_after_supervision", {
                "ral.number": ralNumber,
            });
        } else if (finalPendingDelegationsForCleanup.length === 0 && startedWithPendingDelegations) {
            trace.getActiveSpan()?.addEvent("executor.ral_clear_skipped_pending_at_start", {
                "ral.number": ralNumber,
            });
        }

        const eventContext = createEventContext(context, {
            model: completionEvent?.usage?.model,
        });

        trace.getActiveSpan()?.addEvent("executor.publish", {
            "message.length": completionEvent?.message?.length || 0,
            has_pending_delegations: hasPendingDelegations,
        });

        let responseEvent: NDKEvent | undefined;

        if (hasPendingDelegations) {
            if (completionEvent.message.trim().length > 0) {
                responseEvent = await agentPublisher.conversation(
                    { content: completionEvent.message, usage: completionEvent.usage },
                    eventContext
                );
            }
        } else {
            responseEvent = await agentPublisher.complete(
                { content: completionEvent.message, usage: completionEvent.usage },
                eventContext
            );
        }

        if (responseEvent) {
            await ConversationStore.addEvent(context.conversationId, responseEvent);

            trace.getActiveSpan()?.addEvent("executor.published", {
                "event.id": responseEvent.id || "",
                is_completion: !hasPendingDelegations,
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
        });

        return handler.execute(setup.messages);
    }
}
