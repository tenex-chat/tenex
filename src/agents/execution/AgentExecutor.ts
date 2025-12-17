import type { AgentInstance } from "@/agents/types";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { providerSupportsStreaming } from "@/llm/provider-configs";
import { getProjectContext } from "@/services/ProjectContext";
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
import { executionCoordinator, ClawbackAbortError } from "@/services/execution";
import { PairModeController } from "@/services/delegation/PairModeController";
import { PairModeRegistry } from "@/services/delegation/PairModeRegistry";
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
     * This method builds the messages and determines the tools/configuration
     * but doesn't actually call the LLM.
     */
    async prepareLLMRequest(
        agent: AgentInstance,
        initialPrompt: string,
        originalEvent: NDKEvent,
        conversationHistory: ModelMessage[] = [],
        projectPath?: string
    ): Promise<LLMCompletionRequest> {
        // Build a minimal execution context for message generation
        const context: Partial<ExecutionContext> = {
            agent,
            triggeringEvent: originalEvent,
            conversationId: originalEvent.id, // Use event ID as conversation ID for stateless calls
            projectBasePath: projectPath || this.standaloneContext?.project?.tagValue("d") || "",
            workingDirectory: projectPath || this.standaloneContext?.project?.tagValue("d") || "",
            currentBranch: "main", // Default to main for stateless calls
        };

        // If we have conversation history, prepend it to the messages
        let messages: ModelMessage[] = [];

        if (conversationHistory.length > 0) {
            messages = [...conversationHistory];
        } else {
            // Build messages using the strategy if no history provided
            // Note: This requires a full ExecutionContext with conversationCoordinator
            messages = [
                {
                    role: "user",
                    content: initialPrompt,
                },
            ];
        }

        // Get tools for the agent
        const toolNames = agent.tools || [];
        const tools =
            toolNames.length > 0 ? getToolsObject(toolNames, context as ExecutionContext) : {};

        return {
            messages,
            tools,
        };
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
                // Prepare execution context with all necessary components
                const { fullContext, supervisor, toolTracker, agentPublisher, cleanup } =
                    this.prepareExecution(context);

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
                console.log(chalk.cyan(`\n━━━ ${context.agent.slug} [${modelInfo}] ━━━`));

                logger.info("[AgentExecutor] 🎬 Starting supervised execution", {
                    agent: context.agent.slug,
                    conversationId: context.conversationId.substring(0, 8),
                    hasPhases: !!context.agent.phases,
                    phaseCount: context.agent.phases ? Object.keys(context.agent.phases).length : 0,
                });

                span.addEvent("execution.start", {
                    has_phases: !!context.agent.phases,
                    phase_count: context.agent.phases
                        ? Object.keys(context.agent.phases).length
                        : 0,
                });

                try {
                    // Start execution with supervision
                    const result = await this.executeWithSupervisor(
                        fullContext,
                        supervisor,
                        toolTracker,
                        agentPublisher
                    );

                    span.addEvent("execution.complete");
                    span.setStatus({ code: SpanStatusCode.OK });
                    return result;
                } finally {
                    // Always cleanup
                    await cleanup();
                }
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw error;
            } finally {
                span.end();
            }
        });
    }

    /**
     * Prepare execution context with all necessary components
     */
    private prepareExecution(context: ExecutionContext): {
        fullContext: ExecutionContext;
        supervisor: AgentSupervisor;
        toolTracker: ToolExecutionTracker;
        agentPublisher: AgentPublisher;
        cleanup: () => Promise<void>;
    } {
        // Create core components
        const toolTracker = new ToolExecutionTracker();
        const supervisor = new AgentSupervisor(context.agent, context, toolTracker);
        const agentPublisher = new AgentPublisher(context.agent);

        // Build full context with additional properties
        const fullContext: ExecutionContext = {
            ...context,
            conversationCoordinator: context.conversationCoordinator,
            agentPublisher,
            getConversation: () =>
                context.conversationCoordinator.getConversation(context.conversationId),
        };

        // Get conversation for tracking
        const conversation = fullContext.getConversation();
        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        // Start execution time tracking
        startExecutionTime(conversation);

        // Create cleanup function
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
        context: ExecutionContext,
        supervisor: AgentSupervisor,
        toolTracker: ToolExecutionTracker,
        agentPublisher: AgentPublisher
    ): Promise<NDKEvent | undefined> {
        let completionEvent: CompleteEvent | undefined;

        try {
            // Stream the LLM response
            completionEvent = await this.executeStreaming(context, toolTracker);
        } catch (streamError) {
            // Streaming failed - error was already published in executeStreaming
            // Re-throw to let the caller handle it
            logger.error("[AgentExecutor] Streaming failed in executeWithSupervisor", {
                agent: context.agent.slug,
                error: formatAnyError(streamError),
            });
            throw streamError;
        }

        if (!completionEvent) {
            throw new Error("LLM execution completed without producing a completion event");
        }

        // Create event context for supervisor
        const eventContext = createEventContext(context, completionEvent?.usage?.model);

        const isComplete = await supervisor.isExecutionComplete(
            completionEvent,
            agentPublisher,
            eventContext
        );

        if (!isComplete) {
            logger.info("[AgentExecutor] 🔁 RECURSION: Execution not complete, continuing", {
                agent: context.agent.slug,
                reason: supervisor.getContinuationPrompt(),
            });

            // Only publish intermediate if we had actual content
            if (completionEvent?.message?.trim()) {
                logger.info("[AgentExecutor] Publishing intermediate conversation", {
                    agent: context.agent.slug,
                    contentLength: completionEvent.message.length,
                });
                await agentPublisher.conversation(
                    {
                        content: completionEvent.message,
                    },
                    eventContext
                );
            }

            // Get continuation instructions from supervisor
            context.additionalSystemMessage = supervisor.getContinuationPrompt();

            logger.info("[AgentExecutor] 🔄 Resetting supervisor and recursing", {
                agent: context.agent.slug,
                continuationMessage: context.additionalSystemMessage,
            });

            // Reset supervisor and recurse
            supervisor.reset();
            return this.executeWithSupervisor(context, supervisor, toolTracker, agentPublisher);
        }

        logger.info("[AgentExecutor] ✅ Execution complete, publishing final response", {
            agent: context.agent.slug,
            messageLength: completionEvent?.message?.length || 0,
        });

        // Execution is complete - publish and return
        const finalResponseEvent = await agentPublisher.complete(
            {
                content: completionEvent?.message || "",
                usage: completionEvent?.usage,
            },
            eventContext
        );

        // Display completion in console
        console.log(chalk.green(`\n✅ ${context.agent.slug} completed`));

        logger.info("[AgentExecutor] 🎯 Published final completion event", {
            agent: context.agent.slug,
            eventId: finalResponseEvent?.id,
            usage: completionEvent.usage,
        });

        return finalResponseEvent;
    }

    /**
     * Execute streaming and return the completion event
     */
    private async executeStreaming(
        context: ExecutionContext,
        toolTracker: ToolExecutionTracker
    ): Promise<CompleteEvent | undefined> {
        // Get tools for response processing
        // Tools are already properly configured in AgentRegistry.buildAgentInstance
        const toolNames = context.agent.tools || [];

        // Get tools as a keyed object for AI SDK
        const toolsObject = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

        // Initialize session manager for session resumption
        const sessionManager = new SessionManager(context.agent, context.conversationId);
        const { sessionId } = sessionManager.getSession();

        // Create event filter for resumed sessions
        const eventFilter = sessionManager.createEventFilter();

        // Build messages using the strategy, with optional filter for resumed sessions
        let messages = await this.messageStrategy.buildMessages(
            context,
            context.triggeringEvent,
            eventFilter
        );

        // Register operation with the LLM Operations Registry FIRST
        // This must happen before we try to find it for message injection
        const abortSignal = llmOpsRegistry.registerOperation(context);

        // Find this operation in the registry
        const operationsByEvent = llmOpsRegistry.getOperationsByEvent();
        const activeOperations = operationsByEvent.get(context.conversationId) || [];
        const thisOperation = activeOperations.find(
            (op) => op.agentPubkey === context.agent.pubkey
        );

        // Also register with ExecutionCoordinator for enhanced tracking
        if (thisOperation) {
            executionCoordinator.registerOperation(
                thisOperation.id,
                context.agent.pubkey,
                context.agent.slug,
                context.conversationId
            );

            logger.debug("[AgentExecutor] Registered with ExecutionCoordinator", {
                agent: context.agent.slug,
                conversationId: context.conversationId.substring(0, 8),
                operationId: thisOperation.id.substring(0, 8),
            });

            // Add trace event for registration
            const activeSpan = trace.getActiveSpan();
            if (activeSpan) {
                activeSpan.addEvent("execution_coordinator.registered", {
                    "agent.slug": context.agent.slug,
                    "conversation.id": context.conversationId,
                    "operation.id": thisOperation.id,
                });
            }

            // Listen for inject-message events and queue them with the coordinator
            thisOperation.eventEmitter.on("inject-message", (event: NDKEvent) => {
                logger.info("[AgentExecutor] Queueing injected message with coordinator", {
                    agent: context.agent.slug,
                    eventId: event.id?.substring(0, 8),
                });

                executionCoordinator.queueMessageForInjection(thisOperation.id, event);

                // Add trace event for received injection
                const activeSpan = trace.getActiveSpan();
                if (activeSpan) {
                    activeSpan.addEvent("message_injection.queued", {
                        "event.id": event.id || "",
                        "agent.slug": context.agent.slug,
                    });
                }
            });
        } else {
            logger.error(
                "[AgentExecutor] CRITICAL: Could not find operation for message injection after registration!",
                {
                    agent: context.agent.slug,
                    agentPubkey: context.agent.pubkey.substring(0, 8),
                    conversationId: context.conversationId.substring(0, 8),
                    availableOperations: activeOperations.map((op) => ({
                        agentPubkey: op.agentPubkey.substring(0, 8),
                        operationId: op.id.substring(0, 8),
                    })),
                }
            );
        }

        // Store operation ID for use in callbacks
        const operationId = thisOperation?.id;

        // Add continuation message from supervisor as user message
        // Using "user" role ensures the LLM treats it as a request to act on,
        // not just background context. This is critical for phase continuation
        // where the LLM needs to understand it should continue working.
        if (context.additionalSystemMessage) {
            messages = [
                ...messages,
                {
                    role: "user",
                    content: context.additionalSystemMessage,
                },
            ];
            // Clear it after use
            context.additionalSystemMessage = undefined;
        }

        logger.debug("[AgentExecutor] 📝 Built messages for execution", {
            messageCount: messages.length,
            hasFilter: !!eventFilter,
            sessionId: sessionId || "NONE",
            hasSession: !!sessionId,
            messageTypes: messages.map((msg, i) => {
                const contentStr =
                    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
                return {
                    index: i,
                    role: msg.role,
                    contentLength: contentStr.length,
                    contentPreview: contentStr.substring(0, 100),
                };
            }),
        });

        // Pass tools context and session ID for providers that need runtime configuration (like Claude Code)
        const llmService = context.agent.createLLMService({ tools: toolsObject, sessionId });

        const agentPublisher = context.agentPublisher;
        if (!agentPublisher) {
            throw new Error("AgentPublisher not found in execution context");
        }
        const eventContext = createEventContext(context, llmService.model);

        // Separate buffers for content and reasoning
        let contentBuffer = "";
        let reasoningBuffer = "";
        let completionEvent: CompleteEvent | undefined;

        // Check if provider supports streaming
        const supportsStreaming = isAISdkProvider(llmService.provider)
            ? providerSupportsStreaming(llmService.provider)
            : true;

        // Helper to flush accumulated reasoning
        const flushReasoningBuffer = async (): Promise<void> => {
            if (reasoningBuffer.trim().length > 0) {
                // Publish reasoning as kind:1111 with reasoning tag
                await agentPublisher.conversation(
                    {
                        content: reasoningBuffer,
                        isReasoning: true,
                    },
                    eventContext
                );

                reasoningBuffer = "";
            }
        };

        // Wire up event handlers
        llmService.on("content", async (event: ContentEvent) => {
            logger.debug("[AgentExecutor] RECEIVED CONTENT EVENT!!!", {
                deltaLength: event.delta?.length,
                supportsStreaming,
                preview: event.delta?.substring(0, 100),
                agentName: context.agent.slug,
            });

            // Stream content to console
            process.stdout.write(chalk.white(event.delta));

            // Publish chunks for display
            if (supportsStreaming) {
                contentBuffer += event.delta;
                // For streaming providers, publish as streaming deltas (TenexStreamingResponse)
                await agentPublisher.publishStreamingDelta(event.delta, eventContext, false);
            } else {
                // For non-streaming providers, publish as conversation events (GenericReply)
                await agentPublisher.conversation({ content: event.delta }, eventContext);
            }
        });

        llmService.on("reasoning", async (event: ReasoningEvent) => {
            // Stream reasoning to console in gray
            process.stdout.write(chalk.gray(event.delta));

            // Only accumulate in buffer for streaming providers
            // Non-streaming providers publish each chunk directly
            if (supportsStreaming) {
                reasoningBuffer += event.delta;
            }

            // Publish chunks for display
            if (supportsStreaming) {
                // For streaming providers, publish as streaming deltas (TenexStreamingResponse)
                await agentPublisher.publishStreamingDelta(event.delta, eventContext, true);
            } else {
                // For non-streaming providers, publish as conversation events (GenericReply)
                await agentPublisher.conversation(
                    {
                        content: event.delta,
                        isReasoning: true,
                    },
                    eventContext
                );
            }
        });

        llmService.on("chunk-type-change", async (event: ChunkTypeChangeEvent) => {
            console.log('chunk-type-change event:');
            console.log(event);
            
            logger.debug(`[AgentExecutor] Chunk type changed from ${event.from} to ${event.to}`, {
                agentName: context.agent.slug,
                hasReasoningBuffer: reasoningBuffer.length > 0,
                hasContentBuffer: contentBuffer.length > 0,
            });

            // When switching FROM reasoning to anything else (text-start, text-delta, etc)
            // flush reasoning as complete event
            if (event.from === "reasoning-delta") {
                await flushReasoningBuffer();
            }

            // if we are switching from text-delta to anything else, we flush conversation buffer
            if (event.from === "text-delta" ) {
                if (contentBuffer.trim().length > 0) {
                    await agentPublisher.conversation(
                        {
                            content: contentBuffer,
                        },
                        eventContext
                    );
                    contentBuffer = "";
                }
            }
        });

        llmService.on("complete", (event: CompleteEvent) => {
            // Store the completion event
            completionEvent = event;

            logger.info("[AgentExecutor] LLM complete event received", {
                agent: context.agent.slug,
                messageLength: event.message?.length || 0,
                hasMessage: !!event.message,
                hasReasoning: !!event.reasoning,
                finishReason: event.finishReason,
            });
        });

        llmService.on("stream-error", async (event: StreamErrorEvent) => {
            logger.error("[AgentExecutor] Stream error from LLMService", event);

            // Reset streaming sequence on error
            agentPublisher.resetStreamingSequence();

            // Publish error event to Nostr for visibility
            try {
                const { message: errorMessage, errorType } = formatStreamError(event.error);

                await agentPublisher.error(
                    {
                        message: errorMessage,
                        errorType,
                    },
                    eventContext
                );

                logger.info("Stream error event published via stream-error handler", {
                    agent: context.agent.slug,
                    errorType,
                });
            } catch (publishError) {
                logger.error("Failed to publish stream error event", {
                    error: formatAnyError(publishError),
                });
            }
        });

        // Handle session capture - store any session ID from the provider
        llmService.on("session-captured", ({ sessionId: capturedSessionId }: SessionCapturedEvent) => {
            sessionManager.saveSession(capturedSessionId, context.triggeringEvent.id);
        });

        // Tool tracker is always provided from executeWithSupervisor

        llmService.on("tool-will-execute", async (event: ToolWillExecuteEvent) => {
            // Display tool execution in console
            const argsPreview = JSON.stringify(event.args).substring(0, 50);
            console.log(
                chalk.yellow(
                    `\n🔧 ${event.toolName}(${argsPreview}${JSON.stringify(event.args).length > 50 ? "..." : ""})`
                )
            );

            // Notify ExecutionCoordinator of tool start
            if (operationId) {
                executionCoordinator.onToolStart(operationId, event.toolName);
            }

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
            // Notify ExecutionCoordinator of tool completion
            if (operationId) {
                executionCoordinator.onToolComplete(operationId, event.toolName);
            }

            await toolTracker.completeExecution({
                toolCallId: event.toolCallId,
                result: event.result,
                error: event.error ?? false,
                agentPubkey: context.agent.pubkey,
            });
        });

        // Check if this is a pair mode delegation and create controller if so
        const pairModeController = this.createPairModeController(context);

        try {
            // Capture the current span for use in prepareStep callback
            // prepareStep is called synchronously by AI SDK and may not have access to OTel context
            const executionSpan = trace.getActiveSpan();

            // Create prepareStep callback for message injection, pair mode corrections, and clawback (SYNC)
            const prepareStep = (
                step: { messages: ModelMessage[]; stepNumber: number }
            ): { messages?: ModelMessage[] } | undefined => {
                let result: { messages?: ModelMessage[] } | undefined;

                // Notify ExecutionCoordinator of step start
                if (operationId) {
                    executionCoordinator.onStepStart(operationId, step.stepNumber);

                    // Check for clawback condition - if a message has been waiting too long,
                    // throw ClawbackAbortError to abort and restart
                    const opState = executionCoordinator.getOperationState(operationId);
                    if (opState && opState.injectionQueue.length > 0) {
                        const oldestMessage = opState.injectionQueue[0];
                        const waitTime = Date.now() - oldestMessage.queuedAt;
                        const policy = executionCoordinator.getPolicy();

                        if (waitTime > policy.maxInjectionWaitMs) {
                            logger.warn("[prepareStep] Clawback triggered - message waited too long", {
                                agent: context.agent.slug,
                                waitTimeMs: waitTime,
                                threshold: policy.maxInjectionWaitMs,
                            });

                            // Throw to abort - the message is already in conversation history
                            // so it will be picked up on restart
                            throw new ClawbackAbortError(
                                operationId,
                                `Message waited ${Math.round(waitTime / 1000)}s (threshold: ${policy.maxInjectionWaitMs / 1000}s)`
                            );
                        }
                    }
                }

                // Handle pair mode corrections (sync - corrections queued by onStopCheck)
                if (pairModeController) {
                    const corrections = pairModeController.getPendingCorrections();
                    if (corrections.length > 0) {
                        // Get delegator's slug for the correction message
                        const pairRegistry = PairModeRegistry.getInstance();
                        const pairState = pairRegistry.getState(pairModeController.getBatchId());
                        const delegatorPubkey = pairState?.delegatorPubkey;
                        const delegator = delegatorPubkey
                            ? getProjectContext().getAgentByPubkey(delegatorPubkey)
                            : undefined;
                        const delegatorSlug = delegator?.slug || "delegator";

                        const correctionMessages: ModelMessage[] = corrections.map((msg) => ({
                            role: "user" as const,
                            content: `[PAIR MODE CORRECTION from ${delegatorSlug}]: ${msg}`,
                        }));

                        // Add trace event for pair mode correction injection
                        if (executionSpan) {
                            executionSpan.addEvent("pair_mode.correction_injected", {
                                "correction.count": corrections.length,
                                "correction.step_number": step.stepNumber,
                                "agent.slug": context.agent.slug,
                            });
                        }

                        logger.info("[prepareStep] Injecting pair mode corrections", {
                            agent: context.agent.slug,
                            correctionCount: corrections.length,
                        });

                        result = {
                            messages: [...step.messages, ...correctionMessages],
                        };
                    }
                }

                // Handle message injection from ExecutionCoordinator's queue
                if (operationId) {
                    const injectedMessages = executionCoordinator.drainInjectionQueue(operationId);

                    if (injectedMessages.length > 0) {
                        // Add trace event for message injection processing
                        if (executionSpan) {
                            executionSpan.addEvent("message_injection.process", {
                                "injection.message_count": injectedMessages.length,
                                "injection.step_number": step.stepNumber,
                                "injection.event_ids": injectedMessages.map((m) => m.event.id || "").join(","),
                                "agent.slug": context.agent.slug,
                            });
                        }

                        logger.info(
                            `[prepareStep] Injecting ${injectedMessages.length} new user message(s)`,
                            {
                                agent: context.agent.slug,
                                stepNumber: step.stepNumber,
                            }
                        );

                        const newMessages: ModelMessage[] = [];
                        for (const injectedMessage of injectedMessages) {
                            // Add a system message to signal the injection
                            newMessages.push({
                                role: "system",
                                content:
                                    "[INJECTED USER MESSAGE]: A new message has arrived while you were working. Prioritize this instruction.",
                            });
                            // Add the actual user message
                            newMessages.push({
                                role: "user",
                                content: injectedMessage.event.content,
                            });
                        }

                        // Combine with any pair mode messages
                        const baseMessages = result?.messages || step.messages;
                        result = {
                            messages: [
                                baseMessages[0],
                                ...newMessages,
                                ...baseMessages.slice(1),
                            ],
                        };
                    }
                }

                return result;
            };

            // Create onStopCheck for pair mode (async - handles check-ins)
            const onStopCheck = pairModeController?.createStopCheck();

            // Publish empty 21111 to signal execution start (implicit typing indicator)
            await agentPublisher.publishStreamingDelta("", eventContext, false);

            await llmService.stream(messages, toolsObject, { abortSignal, prepareStep, onStopCheck });

            // If pair mode, check if we were aborted or completed
            if (pairModeController) {
                const pairRegistry = PairModeRegistry.getInstance();
                if (pairModeController.isAborted()) {
                    // Handle abort
                    logger.info("[AgentExecutor] Pair mode delegation was aborted", {
                        agent: context.agent.slug,
                        reason: pairModeController.getAbortReason(),
                    });
                    pairRegistry.abortDelegation(
                        pairModeController.getBatchId(),
                        pairModeController.getAbortReason()
                    );
                } else {
                    // Mark as complete
                    pairRegistry.completeDelegation(pairModeController.getBatchId());
                }
            }
        } catch (streamError) {
            // Handle ClawbackAbortError specially - this is intentional, not an error
            if (streamError instanceof ClawbackAbortError) {
                logger.info("[AgentExecutor] Clawback abort - operation will restart", {
                    agent: context.agent.slug,
                    operationId: streamError.operationId.substring(0, 8),
                    reason: streamError.reason,
                });

                // Clean up pair mode state
                if (pairModeController) {
                    const pairRegistry = PairModeRegistry.getInstance();
                    pairRegistry.abortDelegation(
                        pairModeController.getBatchId(),
                        `Clawback: ${streamError.reason}`
                    );
                }

                // Re-throw to let parent handle restart
                throw streamError;
            }

            // Clean up pair mode state on any other error
            if (pairModeController) {
                const pairRegistry = PairModeRegistry.getInstance();
                pairRegistry.abortDelegation(
                    pairModeController.getBatchId(),
                    streamError instanceof Error ? streamError.message : "Stream error"
                );
            }
            // Publish error event for stream errors
            try {
                const { message: errorMessage, errorType } = formatStreamError(streamError);

                await agentPublisher.error(
                    {
                        message: errorMessage,
                        errorType,
                    },
                    eventContext
                );

                logger.info("Stream error event published to Nostr", {
                    agent: context.agent.slug,
                    errorType,
                });
            } catch (publishError) {
                logger.error("Failed to publish stream error event", {
                    agent: context.agent.slug,
                    error: formatAnyError(publishError),
                });
            }

            // Re-throw to let parent handler catch it
            throw streamError;
        } finally {
            // Complete the operation (handles both success and abort cases)
            llmOpsRegistry.completeOperation(context);

            // Unregister from ExecutionCoordinator
            if (operationId) {
                executionCoordinator.unregisterOperation(operationId);
            }

            // Clean up event listeners
            llmService.removeAllListeners();
        }

        // After streaming, handle cleanup and post-processing
        logger.debug("[AgentExecutor] 🏃 Stream completed, handling post-processing", {
            agent: context.agent.slug,
            hasCompletionEvent: !!completionEvent,
            hasReasoningBuffer: reasoningBuffer.trim().length > 0,
        });

        if (reasoningBuffer.trim().length > 0) {
            await flushReasoningBuffer();
        }

        // Reset streaming sequence counter for next stream
        agentPublisher.resetStreamingSequence();

        // Store lastSentEventId for new Claude Code sessions (without session ID yet)
        if (!sessionId && llmService.provider === "claudeCode" && completionEvent) {
            sessionManager.saveLastSentEventId(context.triggeringEvent.id);
        }

        return completionEvent;
    }

    /**
     * Create a PairModeController if this execution is part of a pair mode delegation.
     * Returns undefined if not in pair mode.
     *
     * The PairModeRegistry is the single source of truth for active pair delegations.
     * It's populated by the DelegationService when a pair mode delegation is started.
     */
    private createPairModeController(context: ExecutionContext): PairModeController | undefined {
        try {
            // PairModeRegistry is the single source of truth for active pair delegations
            const pairRegistry = PairModeRegistry.getInstance();

            // Look for an active pair delegation that this agent might be part of
            const state = pairRegistry.findDelegationByAgent(context.agent.pubkey);

            if (state) {
                logger.info("[AgentExecutor] Creating PairModeController for pair delegation", {
                    agent: context.agent.slug,
                    batchId: state.batchId,
                    stepThreshold: state.config.stepThreshold,
                });

                return new PairModeController(
                    state.batchId,
                    context.agent.pubkey,
                    context.agent.slug,
                    state.config
                );
            }
        } catch (error) {
            logger.warn("[AgentExecutor] Error checking for pair mode delegation", {
                agent: context.agent.slug,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        return undefined;
    }
}
