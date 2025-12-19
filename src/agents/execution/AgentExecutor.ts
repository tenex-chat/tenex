import type { AgentInstance } from "@/agents/types";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { providerSupportsStreaming } from "@/llm/provider-configs";
import type {
    ChunkTypeChangeEvent,
    CompleteEvent,
    ContentEvent,
    ReasoningEvent,
    SessionCapturedEvent,
    StreamErrorEvent,
    ToolDidExecuteEvent,
    ToolWillExecuteEvent,
} from "@/llm/service";
import { isAISdkProvider } from "@/llm/type-guards";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { isProjectContextInitialized, getProjectContext } from "@/services/ProjectContext";
import { RALRegistry, isStopExecutionSignal } from "@/services/ral";
import type { RALSummary } from "@/services/ral";
import { getToolsObject } from "@/tools/registry";
import { formatAnyError, formatStreamError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/phase-utils";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Tool as CoreTool, ModelMessage } from "ai";
import chalk from "chalk";
import { AgentSupervisor } from "./AgentSupervisor";
import { SessionManager } from "./SessionManager";
import { ToolExecutionTracker } from "./ToolExecutionTracker";
import { FlattenedChronologicalStrategy } from "./strategies/FlattenedChronologicalStrategy";
import type { MessageGenerationStrategy } from "./strategies/types";
import type { ExecutionContext, StandaloneAgentContext } from "./types";
import { getConcurrentRALCoordinator } from "./ConcurrentRALCoordinator";
import { addConcurrentRALContext, findTriggeringEventIndex } from "@/conversations/utils/context-enhancers";

const tracer = trace.getTracer("tenex.agent-executor");

export interface LLMCompletionRequest {
    messages: ModelMessage[];
    tools?: Record<string, CoreTool>;
}

export class AgentExecutor {
    private messageStrategy: MessageGenerationStrategy;

    constructor(
        private standaloneContext?: StandaloneAgentContext,
        messageStrategy?: MessageGenerationStrategy
    ) {
        this.messageStrategy = messageStrategy || new FlattenedChronologicalStrategy();
    }

    /**
     * Prepare an LLM request without executing it.
     */
    async prepareLLMRequest(
        agent: AgentInstance,
        initialPrompt: string,
        originalEvent: NDKEvent,
        conversationHistory: ModelMessage[] = [],
        projectPath?: string
    ): Promise<LLMCompletionRequest> {
        const context: Partial<ExecutionContext> = {
            agent,
            triggeringEvent: originalEvent,
            conversationId: originalEvent.id,
            projectBasePath: projectPath || this.standaloneContext?.project?.tagValue("d") || "",
            workingDirectory: projectPath || this.standaloneContext?.project?.tagValue("d") || "",
            currentBranch: "main",
        };

        let messages: ModelMessage[] = [];

        if (conversationHistory.length > 0) {
            messages = [...conversationHistory];
        } else {
            messages = [
                {
                    role: "user",
                    content: initialPrompt,
                },
            ];
        }

        const toolNames = agent.tools || [];
        const tools = toolNames.length > 0 ? getToolsObject(toolNames, context as ExecutionContext) : {};

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
        });

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                const ralRegistry = RALRegistry.getInstance();

                // Check for a resumable RAL (one with completed delegations ready to continue)
                const resumableRal = ralRegistry.findResumableRAL(
                    context.agent.pubkey,
                    context.conversationId
                );

                let ralNumber: number;
                let isResumption = false;

                if (resumableRal) {
                    // Resume existing RAL instead of creating a new one
                    ralNumber = resumableRal.ralNumber;
                    isResumption = true;

                    // Inject delegation results into the RAL
                    const resultsMessage = ralRegistry.buildDelegationResultsMessage(
                        resumableRal.completedDelegations
                    );
                    if (resultsMessage) {
                        ralRegistry.queueSystemMessage(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber,
                            resultsMessage
                        );
                    }

                    // Clear completed delegations now that we've queued them for processing
                    ralRegistry.clearCompletedDelegations(
                        context.agent.pubkey,
                        context.conversationId,
                        ralNumber
                    );

                    span.addEvent("executor.ral_resumed", {
                        "ral.number": ralNumber,
                        "delegation.completed_count": resumableRal.completedDelegations.length,
                    });
                } else {
                    // Create a new RAL for this execution
                    ralNumber = ralRegistry.create(
                        context.agent.pubkey,
                        context.conversationId,
                        context.triggeringEvent.id
                    );
                }

                // Check for other active RALs in this conversation
                const existingRALs = ralRegistry.getActiveRALs(context.agent.pubkey, context.conversationId);

                span.setAttributes({
                    "ral.number": ralNumber,
                    "ral.is_resumption": isResumption,
                    "ral.other_active_count": existingRALs.length - 1, // Exclude self
                });

                // Get summaries of other RALs to inject as context
                const otherRALSummaries = ralRegistry.getOtherRALSummaries(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );

                if (otherRALSummaries.length > 0) {
                    span.addEvent("executor.concurrent_rals", {
                        "ral.count": otherRALSummaries.length,
                        "ral.numbers": otherRALSummaries.map(r => r.ralNumber).join(","),
                    });

                    // Pause other RALs to give this new RAL time to analyze and decide
                    const activeRalsBeforePause = ralRegistry.getActiveRALs(
                        context.agent.pubkey,
                        context.conversationId
                    );

                    span.addEvent("rals_pause_attempt", {
                        pausing_ral: ralNumber,
                        active_ral_count: activeRalsBeforePause.length,
                        active_ral_numbers: activeRalsBeforePause.map(r => r.ralNumber).join(","),
                        other_ral_summary_count: otherRALSummaries.length,
                    });

                    const pausedCount = ralRegistry.pauseOtherRALs(
                        context.agent.pubkey,
                        context.conversationId,
                        ralNumber
                    );

                    span.addEvent("executor.rals_paused", {
                        "ral.pausing_number": ralNumber,
                        "ral.paused_count": pausedCount,
                    });
                }

                // Store ralNumber in context for use throughout execution
                const contextWithRal = {
                    ...context,
                    ralNumber,
                    otherRALSummaries,
                };

                // Prepare execution context with all necessary components
                const { fullContext, supervisor, toolTracker, agentPublisher, cleanup } =
                    this.prepareExecution(contextWithRal);

                // Add execution context to span
                const conversation = fullContext.getConversation();
                if (conversation) {
                    span.setAttributes({
                        "conversation.phase": conversation.phase,
                        "conversation.message_count": conversation.history.length,
                    });
                }

                // Get the model info early for console output
                const llmService = context.agent.createLLMService({});
                const modelInfo = llmService.model || "unknown";

                // Display execution start in console
                const ralLabel = isResumption
                    ? ` (RAL #${ralNumber} resuming)`
                    : existingRALs.length > 1 ? ` (RAL #${ralNumber})` : "";
                console.log(chalk.cyan(`\n━━━ ${context.agent.slug} [${modelInfo}]${ralLabel} ━━━`));

                span.addEvent("executor.started", {
                    ral_number: ralNumber,
                    is_resumption: isResumption,
                    has_phases: !!context.agent.phases,
                    concurrent_rals: existingRALs.length - 1,
                });

                try {
                    const result = await this.executeWithSupervisor(
                        fullContext,
                        supervisor,
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

                // Clean up this RAL on error (not all RALs)
                // Note: We don't have ralNumber here if creation failed
                logger.debug("[AgentExecutor] Error during execution", {
                    agent: context.agent.slug,
                    error: formatAnyError(error),
                });

                throw error;
            } finally {
                span.end();
            }
        });
    }

    /**
     * Prepare execution context with all necessary components
     */
    private prepareExecution(context: ExecutionContext & { ralNumber: number; otherRALSummaries: RALSummary[] }): {
        fullContext: ExecutionContext & { ralNumber: number; otherRALSummaries: RALSummary[] };
        supervisor: AgentSupervisor;
        toolTracker: ToolExecutionTracker;
        agentPublisher: AgentPublisher;
        cleanup: () => Promise<void>;
    } {
        const toolTracker = new ToolExecutionTracker();
        const supervisor = new AgentSupervisor(context.agent, context, toolTracker);
        const agentPublisher = new AgentPublisher(context.agent);

        // Check for active pairings for this agent
        let hasActivePairings = false;
        if (isProjectContextInitialized()) {
            const projectContext = getProjectContext();
            if (projectContext.pairingManager) {
                const activePairings = projectContext.pairingManager.getActivePairingsForSupervisor(context.agent.pubkey);
                hasActivePairings = activePairings.length > 0;
            }
        }

        const fullContext = {
            ...context,
            conversationCoordinator: context.conversationCoordinator,
            agentPublisher,
            hasConcurrentRALs: context.otherRALSummaries.length > 0,
            hasActivePairings,
            getConversation: () => context.conversationCoordinator.getConversation(context.conversationId),
        };

        const conversation = fullContext.getConversation();
        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        startExecutionTime(conversation);

        const cleanup = async (): Promise<void> => {
            if (conversation) stopExecutionTime(conversation);
            toolTracker.clear();
        };

        return { fullContext, supervisor, toolTracker, agentPublisher, cleanup };
    }

    /**
     * Execute with supervisor oversight and retry capability
     */
    private async executeWithSupervisor(
        context: ExecutionContext & { ralNumber: number; otherRALSummaries: RALSummary[] },
        supervisor: AgentSupervisor,
        toolTracker: ToolExecutionTracker,
        agentPublisher: AgentPublisher,
        ralNumber: number
    ): Promise<NDKEvent | undefined> {
        let completionEvent: CompleteEvent | undefined;

        try {
            completionEvent = await this.executeStreaming(context, toolTracker, ralNumber);
        } catch (streamError) {
            logger.error("[AgentExecutor] Streaming failed in executeWithSupervisor", {
                agent: context.agent.slug,
                error: formatAnyError(streamError),
            });
            throw streamError;
        }

        // Check if we have pending delegations
        const ralRegistry = RALRegistry.getInstance();
        const ralState = ralRegistry.getRAL(context.agent.pubkey, context.conversationId, ralNumber);

        if (ralState?.pendingDelegations.length) {
            trace.getActiveSpan()?.addEvent("executor.pending_delegations", {
                "ral.number": ralNumber,
                "delegation.pending_count": ralState.pendingDelegations.length,
            });

            console.log(chalk.yellow(`\n⏳ ${context.agent.slug} (RAL #${ralNumber}) - awaiting ${ralState.pendingDelegations.length} delegation(s)`));

            return undefined;
        }

        if (!completionEvent) {
            throw new Error("LLM execution completed without producing a completion event");
        }

        const eventContext = createEventContext(context, completionEvent?.usage?.model);

        const isComplete = await supervisor.isExecutionComplete(
            completionEvent,
            agentPublisher,
            eventContext
        );

        if (!isComplete) {
            trace.getActiveSpan()?.addEvent("executor.recursion", {
                "reason": supervisor.getContinuationPrompt().substring(0, 200),
            });

            if (completionEvent?.message?.trim()) {
                await agentPublisher.conversation(
                    { content: completionEvent.message },
                    eventContext
                );
            }

            context.additionalSystemMessage = supervisor.getContinuationPrompt();
            supervisor.reset();
            return this.executeWithSupervisor(context, supervisor, toolTracker, agentPublisher, ralNumber);
        }

        trace.getActiveSpan()?.addEvent("executor.complete", {
            "message.length": completionEvent?.message?.length || 0,
        });

        const finalResponseEvent = await agentPublisher.complete(
            {
                content: completionEvent?.message || "",
                usage: completionEvent?.usage,
            },
            eventContext
        );

        console.log(chalk.green(`\n✅ ${context.agent.slug} (RAL #${ralNumber}) completed`));

        trace.getActiveSpan()?.addEvent("executor.final_published", {
            "event.id": finalResponseEvent?.id || "",
        });

        return finalResponseEvent;
    }

    /**
     * Execute streaming and return the completion event
     */
    private async executeStreaming(
        context: ExecutionContext & { ralNumber: number; otherRALSummaries: RALSummary[] },
        toolTracker: ToolExecutionTracker,
        ralNumber: number
    ): Promise<CompleteEvent | undefined> {
        const toolNames = context.agent.tools || [];
        const toolsObject = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

        const sessionManager = new SessionManager(context.agent, context.conversationId);
        const { sessionId } = sessionManager.getSession();

        const ralRegistry = RALRegistry.getInstance();
        let messages: ModelMessage[];

        if (ralRegistry.hasMessages(context.agent.pubkey, context.conversationId, ralNumber)) {
            // Recursion: use RAL messages
            messages = ralRegistry.getMessages(context.agent.pubkey, context.conversationId, ralNumber) as ModelMessage[];
            trace.getActiveSpan()?.addEvent("executor.using_ral_messages", {
                "ral.number": ralNumber,
                "message.count": messages.length,
            });
        } else {
            // First iteration: build from conversation history
            const eventFilter = sessionManager.createEventFilter();
            messages = await this.messageStrategy.buildMessages(
                context,
                context.triggeringEvent,
                eventFilter
            );

            // Find the triggering event index (last user message) before adding concurrent context
            const triggeringEventIndex = findTriggeringEventIndex(messages);

            // Add concurrent RAL context if there are other active RALs
            addConcurrentRALContext(
                messages,
                context.otherRALSummaries,
                ralNumber,
                context.triggeringEvent.content,
                context.agent.name
            );

            // Save to RAL as single source of truth, with the triggering event index
            ralRegistry.saveMessages(context.agent.pubkey, context.conversationId, ralNumber, messages, triggeringEventIndex);
            trace.getActiveSpan()?.addEvent("executor.messages_built", {
                "ral.number": ralNumber,
                "message.count": messages.length,
                "has_concurrent_context": context.otherRALSummaries.length > 0,
            });
        }

        const abortSignal = llmOpsRegistry.registerOperation(context);

        // Add continuation message from supervisor
        if (context.additionalSystemMessage) {
            messages = [
                ...messages,
                {
                    role: "user",
                    content: context.additionalSystemMessage,
                },
            ];
            context.additionalSystemMessage = undefined;
        }

        const llmService = context.agent.createLLMService({ tools: toolsObject, sessionId });

        const agentPublisher = context.agentPublisher;
        if (!agentPublisher) {
            throw new Error("AgentPublisher not found in execution context");
        }
        const eventContext = createEventContext(context, llmService.model);

        let contentBuffer = "";
        let reasoningBuffer = "";
        let completionEvent: CompleteEvent | undefined;

        const supportsStreaming = isAISdkProvider(llmService.provider)
            ? providerSupportsStreaming(llmService.provider)
            : true;

        const flushReasoningBuffer = async (): Promise<void> => {
            if (reasoningBuffer.trim().length > 0) {
                await agentPublisher.conversation(
                    { content: reasoningBuffer, isReasoning: true },
                    eventContext
                );
                reasoningBuffer = "";
            }
        };

        llmService.on("content", async (event: ContentEvent) => {
            process.stdout.write(chalk.white(event.delta));

            if (supportsStreaming) {
                contentBuffer += event.delta;
                await agentPublisher.publishStreamingDelta(event.delta, eventContext, false);
            } else {
                await agentPublisher.conversation({ content: event.delta }, eventContext);
            }
        });

        llmService.on("reasoning", async (event: ReasoningEvent) => {
            process.stdout.write(chalk.gray(event.delta));

            if (supportsStreaming) {
                reasoningBuffer += event.delta;
                await agentPublisher.publishStreamingDelta(event.delta, eventContext, true);
            } else {
                await agentPublisher.conversation({ content: event.delta, isReasoning: true }, eventContext);
            }
        });

        llmService.on("chunk-type-change", async (event: ChunkTypeChangeEvent) => {
            if (event.from === "reasoning-delta") {
                await flushReasoningBuffer();
            }

            if (event.from === "text-delta" && contentBuffer.trim().length > 0) {
                await agentPublisher.conversation({ content: contentBuffer }, eventContext);
                contentBuffer = "";
            }
        });

        llmService.on("complete", (event: CompleteEvent) => {
            completionEvent = event;
        });

        llmService.on("stream-error", async (event: StreamErrorEvent) => {
            logger.error("[AgentExecutor] Stream error from LLMService", event);
            agentPublisher.resetStreamingSequence();

            try {
                const { message: errorMessage, errorType } = formatStreamError(event.error);
                await agentPublisher.error({ message: errorMessage, errorType }, eventContext);
            } catch (publishError) {
                logger.error("Failed to publish stream error event", { error: formatAnyError(publishError) });
            }
        });

        llmService.on("session-captured", ({ sessionId: capturedSessionId }: SessionCapturedEvent) => {
            sessionManager.saveSession(capturedSessionId, context.triggeringEvent.id);
        });

        llmService.on("tool-will-execute", async (event: ToolWillExecuteEvent) => {
            const argsStr = event.args !== undefined ? JSON.stringify(event.args) : "";
            const argsPreview = argsStr.substring(0, 50);
            console.log(chalk.yellow(`\n🔧 ${event.toolName}(${argsPreview}${argsStr.length > 50 ? "..." : ""})`));

            await toolTracker.trackExecution({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
                toolsObject,
                agentPublisher,
                eventContext,
            });
        });

        llmService.on("tool-did-execute", async (event: ToolDidExecuteEvent) => {
            await toolTracker.completeExecution({
                toolCallId: event.toolCallId,
                result: event.result,
                error: event.error ?? false,
                agentPubkey: context.agent.pubkey,
            });
        });

        const executionSpan = trace.getActiveSpan();

        // Track whether we've released paused RALs (happens after first step)
        let hasReleasedPausedRALs = false;

        // Track accumulated messages from prepareStep - this is updated before each step
        // and includes all messages up to (but not including) the current step
        let latestAccumulatedMessages: ModelMessage[] = messages;

        try {
            // Mark this RAL as streaming
            ralRegistry.setStreaming(context.agent.pubkey, context.conversationId, ralNumber, true);

            // prepareStep: synchronous, handles injections and release of paused RALs
            const prepareStep = (
                step: {
                    messages: ModelMessage[];
                    stepNumber: number;
                    steps: Array<{ toolCalls: Array<{ toolName: string }>; text: string; reasoningText?: string }>;
                }
            ): { messages?: ModelMessage[] } | undefined => {
                // Update accumulated messages tracker - this is called BEFORE each step,
                // so step.messages includes all messages up to but not including the current step
                latestAccumulatedMessages = step.messages;

                // Check if we should release paused RALs based on completed steps
                // Only release after a step with actual tool calls (agent made a decision)
                if (!hasReleasedPausedRALs && step.steps.length > 0) {
                    const stepsInfo = step.steps.map((s, i) => ({
                        stepNumber: i,
                        toolCalls: s.toolCalls || [],
                        text: s.text || "",
                        reasoningText: s.reasoningText,
                    }));

                    if (getConcurrentRALCoordinator().shouldReleasePausedRALs(stepsInfo)) {
                        hasReleasedPausedRALs = true;

                        // Log what tool calls triggered the release
                        const triggeringToolCalls = stepsInfo
                            .flatMap(s => s.toolCalls.map(tc => tc.toolName))
                            .join(", ");

                        const releasedCount = ralRegistry.releaseOtherRALs(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber
                        );

                        if (releasedCount > 0 && executionSpan) {
                            executionSpan.addEvent("executor.rals_released", {
                                "ral.releasing_number": ralNumber,
                                "ral.released_count": releasedCount,
                                "step.completed_count": step.steps.length,
                                "step.triggering_tools": triggeringToolCalls,
                            });
                        }
                    }
                }

                const newInjections = ralRegistry.getAndPersistInjections(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );

                if (newInjections.length === 0) {
                    return undefined;
                }

                const injectedMessages: ModelMessage[] = newInjections.map((q) => ({
                    role: q.role,
                    content: q.content,
                }));

                if (executionSpan) {
                    executionSpan.addEvent("ral_injection.process", {
                        "injection.message_count": newInjections.length,
                        "ral.number": ralNumber,
                    });
                }

                return { messages: [...step.messages, ...injectedMessages] };
            };

            const onStopCheck = async (steps: any[]): Promise<boolean> => {
                // Check if this RAL is paused by another RAL (e.g., a new RAL started)
                // Awaiting here (in async onStopCheck) allows us to pause between steps
                const pausePromise = ralRegistry.getPausePromise(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );

                if (pausePromise) {
                    const pausedBy = ralRegistry.getRAL(
                        context.agent.pubkey,
                        context.conversationId,
                        ralNumber
                    )?.pausedByRalNumber;

                    executionSpan?.addEvent("executor.ral_paused_waiting", {
                        "ral.number": ralNumber,
                        "ral.paused_by": pausedBy,
                    });

                    // Wait for the pause to be released
                    await pausePromise;

                    executionSpan?.addEvent("executor.ral_resumed", {
                        "ral.number": ralNumber,
                    });
                }

                if (steps.length === 0) return false;

                const lastStep = steps[steps.length - 1];
                const toolResults = lastStep.toolResults ?? [];

                for (const toolResult of toolResults) {
                    if (isStopExecutionSignal(toolResult.output)) {
                        const pendingDelegations = toolResult.output.pendingDelegations;

                        executionSpan?.addEvent("executor.delegation_stop", {
                            "ral.number": ralNumber,
                            "delegation.count": pendingDelegations.length,
                        });

                        // Build complete messages including the current step's tool calls and results.
                        // latestAccumulatedMessages has messages up to but not including this step.
                        // We need to add the assistant's tool calls and the tool results.
                        const toolCalls = lastStep.toolCalls ?? [];
                        const messagesWithToolCalls: ModelMessage[] = [...latestAccumulatedMessages];

                        // Add assistant message with tool calls (if any)
                        if (toolCalls.length > 0) {
                            messagesWithToolCalls.push({
                                role: "assistant",
                                content: toolCalls.map((tc: { toolCallId: string; toolName: string; args: unknown }) => ({
                                    type: "tool-call" as const,
                                    toolCallId: tc.toolCallId,
                                    toolName: tc.toolName,
                                    // AI SDK requires 'input' field, default to {} if undefined
                                    input: tc.args !== undefined ? tc.args : {},
                                })),
                            });
                        }

                        // Add tool results
                        if (toolResults.length > 0) {
                            messagesWithToolCalls.push({
                                role: "tool",
                                content: toolResults.map((tr: { toolCallId: string; toolName: string; result: unknown }) => ({
                                    type: "tool-result" as const,
                                    toolCallId: tr.toolCallId,
                                    toolName: tr.toolName,
                                    // AI SDK requires 'output' field, default to empty if undefined
                                    output: tr.result !== undefined ? tr.result : { type: "text", value: "" },
                                })),
                            });
                        }

                        ralRegistry.saveState(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber,
                            messagesWithToolCalls,
                            pendingDelegations
                        );

                        return true;
                    }
                }

                return false;
            };

            await agentPublisher.publishStreamingDelta("", eventContext, false);
            await llmService.stream(messages, toolsObject, { abortSignal, prepareStep, onStopCheck });
        } catch (streamError) {
            try {
                const { message: errorMessage, errorType } = formatStreamError(streamError);
                await agentPublisher.error({ message: errorMessage, errorType }, eventContext);
            } catch (publishError) {
                logger.error("Failed to publish stream error event", { error: formatAnyError(publishError) });
            }
            throw streamError;
        } finally {
            // Mark as no longer streaming
            ralRegistry.setStreaming(context.agent.pubkey, context.conversationId, ralNumber, false);

            // Safety release: ensure any RALs we paused are released on cleanup
            if (!hasReleasedPausedRALs) {
                const releasedCount = ralRegistry.releaseOtherRALs(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );

                if (releasedCount > 0) {
                    executionSpan?.addEvent("executor.rals_released_cleanup", {
                        "ral.releasing_number": ralNumber,
                        "ral.released_count": releasedCount,
                    });
                }
            }

            llmOpsRegistry.completeOperation(context);
            llmService.removeAllListeners();
        }

        if (reasoningBuffer.trim().length > 0) {
            await flushReasoningBuffer();
        }

        agentPublisher.resetStreamingSequence();

        if (!sessionId && llmService.provider === "claudeCode" && completionEvent) {
            sessionManager.saveLastSentEventId(context.triggeringEvent.id);
        }

        // Handle RAL state based on finish reason
        const finalRalState = ralRegistry.getRAL(context.agent.pubkey, context.conversationId, ralNumber);

        if (!finalRalState?.pendingDelegations.length &&
            (completionEvent?.finishReason === "stop" || completionEvent?.finishReason === "end")) {
            ralRegistry.clearRAL(context.agent.pubkey, context.conversationId, ralNumber);
        }

        return completionEvent;
    }
}
