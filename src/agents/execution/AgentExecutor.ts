import { AgentPublisher } from "@/nostr/AgentPublisher";
import { formatAnyError, formatStreamError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage, Tool as CoreTool } from "ai";
import type { CompleteEvent } from "@/llm/service";
import { getToolsObject } from "@/tools/registry";
import type { ExecutionContext, StandaloneAgentContext } from "./types";
import type { AgentInstance } from "@/agents/types";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import type { MessageGenerationStrategy } from "./strategies/types";
import { FlattenedChronologicalStrategy } from "./strategies/FlattenedChronologicalStrategy";
import { providerSupportsStreaming } from "@/llm/provider-configs";
import { isAISdkProvider } from "@/llm/type-guards";
import { ToolExecutionTracker } from "./ToolExecutionTracker";
import { AgentSupervisor } from "./AgentSupervisor";
import { createEventContext } from "@/utils/phase-utils";
import { BrainstormModerator, type BrainstormResponse, type ModerationResult } from "./BrainstormModerator";
import { SessionManager } from "./SessionManager";
import { trace, context as otelContext, SpanStatusCode } from "@opentelemetry/api";

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
     * but doesn't actually call the LLM. Used by BrainstormService.
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
            projectPath: projectPath || this.standaloneContext?.project?.tagValue("d") || "",
        };

        // If we have conversation history, prepend it to the messages
        let messages: ModelMessage[] = [];
        
        if (conversationHistory.length > 0) {
            messages = [...conversationHistory];
        } else {
            // Build messages using the strategy if no history provided
            // Note: This requires a full ExecutionContext with conversationCoordinator
            // For brainstorming, we'll build messages manually
            messages = [
                {
                    role: "user",
                    content: initialPrompt
                }
            ];
        }

        // Get tools for the agent
        const toolNames = agent.tools || [];
        const tools = toolNames.length > 0 ? getToolsObject(toolNames, context as ExecutionContext) : {};

        return {
            messages,
            tools
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

        return otelContext.with(
            trace.setSpan(otelContext.active(), span),
            async () => {
                try {
                    // Prepare execution context with all necessary components
                    const { fullContext, supervisor, toolTracker, agentPublisher, cleanup } = this.prepareExecution(context);

                    // Add execution context to span
                    const conversation = fullContext.getConversation();
                    if (conversation) {
                        span.setAttributes({
                            "conversation.phase": conversation.phase,
                            "conversation.message_count": conversation.history.length,
                        });
                    }

                    logger.info("[AgentExecutor] 🎬 Starting supervised execution", {
                        agent: context.agent.slug,
                        conversationId: context.conversationId.substring(0, 8),
                        hasPhases: !!context.agent.phases,
                        phaseCount: context.agent.phases ? Object.keys(context.agent.phases).length : 0
                    });

                    span.addEvent("execution.start", {
                        "has_phases": !!context.agent.phases,
                        "phase_count": context.agent.phases ? Object.keys(context.agent.phases).length : 0,
                    });

                    try {
                        // Start execution with supervision
                        const result = await this.executeWithSupervisor(fullContext, supervisor, toolTracker, agentPublisher);

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
            }
        );
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
            getConversation: () => context.conversationCoordinator.getConversation(context.conversationId),
        };

        // Get conversation for tracking
        const conversation = fullContext.getConversation();
        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        // Start execution time tracking
        startExecutionTime(conversation);

        // Publish typing indicator start
        const eventContext = createEventContext(context);
        agentPublisher.typing({ state: "start" }, eventContext).catch(err =>
            logger.warn("Failed to start typing indicator", { error: err })
        );

        // Create cleanup function
        const cleanup = async (): Promise<void> => {
            if (conversation) stopExecutionTime(conversation);
            toolTracker.clear();

            // Ensure typing indicator is stopped
            try {
                const eventContext = createEventContext(context);
                await agentPublisher.typing({ state: "stop" }, eventContext);
            } catch (typingError) {
                logger.warn("Failed to stop typing indicator", {
                    error: formatAnyError(typingError),
                });
            }
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
        logger.info("[AgentExecutor] 🎬 Starting supervised execution", {
            agent: context.agent.slug,
            conversationId: context.conversationId.substring(0, 8),
            hasPhases: !!context.agent.phases,
            phaseCount: context.agent.phases ? Object.keys(context.agent.phases).length : 0
        });

        let completionEvent: CompleteEvent | undefined;

        try {
            // Stream the LLM response
            completionEvent = await this.executeStreaming(context, toolTracker);
        } catch (streamError) {
            // Streaming failed - error was already published in executeStreaming
            // Re-throw to let the caller handle it
            logger.error("[AgentExecutor] Streaming failed in executeWithSupervisor", {
                agent: context.agent.slug,
                error: formatAnyError(streamError)
            });
            throw streamError;
        }

        // Create event context for supervisor
        const eventContext = createEventContext(context, completionEvent?.usage?.model);

        const isComplete = await supervisor.isExecutionComplete(completionEvent, agentPublisher, eventContext);

        if (!isComplete) {
            logger.info("[AgentExecutor] 🔁 RECURSION: Execution not complete, continuing", {
                agent: context.agent.slug,
                reason: supervisor.getContinuationPrompt()
            });

            // Only publish intermediate if we had actual content
            if (completionEvent?.message?.trim()) {
                logger.info("[AgentExecutor] Publishing intermediate conversation", {
                    agent: context.agent.slug,
                    contentLength: completionEvent.message.length
                });
                await agentPublisher.conversation({
                    content: completionEvent.message
                }, eventContext);
            }

            // Get continuation instructions from supervisor
            context.additionalSystemMessage = supervisor.getContinuationPrompt();

            logger.info("[AgentExecutor] 🔄 Resetting supervisor and recursing", {
                agent: context.agent.slug,
                systemMessage: context.additionalSystemMessage
            });

            // Reset supervisor and recurse
            supervisor.reset();
            return this.executeWithSupervisor(context, supervisor, toolTracker, agentPublisher);
        }

        logger.info("[AgentExecutor] ✅ Execution complete, publishing final response", {
            agent: context.agent.slug,
            messageLength: completionEvent?.message?.length || 0
        });

        // Execution is complete - publish and return
        const finalResponseEvent = await agentPublisher.complete({
            content: completionEvent?.message || "",
            usage: completionEvent?.usage
        }, eventContext);

        logger.info("[AgentExecutor] 🎯 Published final completion event", {
            agent: context.agent.slug,
            eventId: finalResponseEvent?.id,
            usage: completionEvent.usage
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

        // Setup message injection system
        const injectedEvents: NDKEvent[] = [];

        // Find this operation in the registry and listen for injected messages
        const operationsByEvent = llmOpsRegistry.getOperationsByEvent();
        const activeOperations = operationsByEvent.get(context.conversationId) || [];
        const thisOperation = activeOperations.find(op => op.agentPubkey === context.agent.pubkey);

        if (thisOperation) {
            logger.debug("[AgentExecutor] Setting up message injection listener", {
                agent: context.agent.slug,
                conversationId: context.conversationId.substring(0, 8),
                operationId: thisOperation.id.substring(0, 8)
            });
            thisOperation.eventEmitter.on("inject-message", (event: NDKEvent) => {
                logger.info("[AgentExecutor] Received injected message", {
                    agent: context.agent.slug,
                    eventId: event.id?.substring(0, 8),
                    currentQueueSize: injectedEvents.length
                });
                injectedEvents.push(event);
            });
        } else {
            logger.error("[AgentExecutor] CRITICAL: Could not find operation for message injection after registration!", {
                agent: context.agent.slug,
                agentPubkey: context.agent.pubkey.substring(0, 8),
                conversationId: context.conversationId.substring(0, 8),
                availableOperations: activeOperations.map(op => ({
                    agentPubkey: op.agentPubkey.substring(0, 8),
                    operationId: op.id.substring(0, 8)
                }))
            });
        }

        // Add any additional system message from retry
        if (context.additionalSystemMessage) {
            messages = [...messages, {
                role: "system",
                content: context.additionalSystemMessage
            }];
            // Clear it after use
            delete context.additionalSystemMessage;
        }

        logger.debug("[AgentExecutor] 📝 Built messages for execution", {
            messageCount: messages.length,
            hasFilter: !!eventFilter,
            sessionId: sessionId || "NONE",
            hasSession: !!sessionId,
            messageTypes: messages.map((msg, i) => {
                const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
                return {
                    index: i,
                    role: msg.role,
                    contentLength: contentStr.length,
                    contentPreview: contentStr.substring(0, 100)
                };
            })
        });

        // Pass tools context and session ID for providers that need runtime configuration (like Claude Code)
        const llmService = context.agent.createLLMService({ tools: toolsObject, sessionId });

        const agentPublisher = context.agentPublisher;
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
                await agentPublisher.conversation({
                    content: reasoningBuffer,
                    isReasoning: true
                }, eventContext);

                reasoningBuffer = "";
            }
        };

        // Wire up event handlers
        llmService.on("content", async (event) => {
            logger.debug("[AgentExecutor] RECEIVED CONTENT EVENT!!!", {
                deltaLength: event.delta?.length,
                supportsStreaming,
                preview: event.delta?.substring(0, 100),
                agentName: context.agent.slug,
            });

            // Publish chunks for display
            if (supportsStreaming) {
                contentBuffer += event.delta;
                // For streaming providers, publish as streaming deltas (kind:21111)
                await agentPublisher.publishStreamingDelta(event.delta, eventContext, false);
            } else {
                // For non-streaming providers, publish as conversation events (kind:1111)
                await agentPublisher.conversation({ content: event.delta }, eventContext);
            }
        });

        llmService.on("reasoning", async (event) => {
            // Only accumulate in buffer for streaming providers
            // Non-streaming providers publish each chunk directly
            if (supportsStreaming) {
                reasoningBuffer += event.delta;
            }

            // Publish chunks for display
            if (supportsStreaming) {
                // For streaming providers, publish as streaming deltas (kind:21111)
                await agentPublisher.publishStreamingDelta(event.delta, eventContext, true);
            } else {
                // For non-streaming providers, publish as conversation events (kind:1111)
                await agentPublisher.conversation({
                    content: event.delta,
                    isReasoning: true
                }, eventContext);
            }
        });

        llmService.on("chunk-type-change", async (event) => {
            logger.debug(`[AgentExecutor] Chunk type changed from ${event.from} to ${event.to}`, {
                agentName: context.agent.slug,
                hasReasoningBuffer: reasoningBuffer.length > 0,
                hasContentBuffer: contentBuffer.length > 0
            });

            // When switching FROM reasoning to anything else (text-start, text-delta, etc)
            // flush reasoning as complete event
            if (event.from === "reasoning-delta") {
                await flushReasoningBuffer();
            }
        });

        llmService.on("complete", (event) => {
            // Store the completion event
            completionEvent = event;
            console.log("complete event", event.message);

            logger.info("[AgentExecutor] LLM complete event received", {
                agent: context.agent.slug,
                messageLength: event.message?.length || 0,
                hasMessage: !!event.message,
                hasReasoning: !!event.reasoning,
                finishReason: event.finishReason
            });
        });
        
        llmService.on("stream-error", async (event) => {
            logger.error("[AgentExecutor] Stream error from LLMService", event);

            // Reset streaming sequence on error
            agentPublisher.resetStreamingSequence();

            // Publish error event to Nostr for visibility
            try {
                const { message: errorMessage, errorType } = formatStreamError(event.error);

                await agentPublisher.error({
                    message: errorMessage,
                    errorType
                }, eventContext);

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
        llmService.on("session-captured", ({ sessionId: capturedSessionId }) => {
            sessionManager.saveSession(capturedSessionId, context.triggeringEvent.id);
        });

        // Tool tracker is always provided from executeWithSupervisor

        llmService.on("tool-will-execute", async (event) => {
            await toolTracker.trackExecution({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
                toolsObject,
                agentPublisher,
                eventContext
            });
        });

        llmService.on("tool-did-execute", async (event) => {
            await toolTracker.completeExecution({
                toolCallId: event.toolCallId,
                result: event.result,
                error: event.error ?? false,
                agentPubkey: context.agent.pubkey
            });
        });

        try {
            // Create prepareStep callback for message injection
            const prepareStep = (step: { messages: ModelMessage[]; stepNumber: number }): void => {
                if (injectedEvents.length > 0) {
                    logger.info(`[prepareStep] Injecting ${injectedEvents.length} new user message(s)`, {
                        agent: context.agent.slug,
                        stepNumber: step.stepNumber
                    });

                    const newMessages: ModelMessage[] = [];
                    for (const injectedEvent of injectedEvents) {
                        // Add a system message to signal the injection
                        newMessages.push({
                            role: "system",
                            content: "[INJECTED USER MESSAGE]: A new message has arrived while you were working. Prioritize this instruction."
                        });
                        // Add the actual user message
                        newMessages.push({
                            role: "user",
                            content: injectedEvent.content
                        });
                    }

                    // Clear the queue after preparing them
                    injectedEvents.length = 0;

                    // Insert new messages after the system prompt but before the rest of history
                    return {
                        messages: [
                            step.messages[0], // Keep the original system prompt
                            ...newMessages,   // Inject new user messages
                            ...step.messages.slice(1) // The rest of the conversation history
                        ]
                    };
                }
            };

            await llmService.stream(messages, toolsObject, { abortSignal, prepareStep });
        } catch (streamError) {
            // Publish error event for stream errors
            try {
                const { message: errorMessage, errorType } = formatStreamError(streamError);

                await agentPublisher.error({
                    message: errorMessage,
                    errorType
                }, eventContext);

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

            // Clean up event listeners
            llmService.removeAllListeners();
        }

        // After streaming, handle cleanup and post-processing
        logger.debug("[AgentExecutor] 🏃 Stream completed, handling post-processing", {
            agent: context.agent.slug,
            hasCompletionEvent: !!completionEvent,
            hasReasoningBuffer: reasoningBuffer.trim().length > 0
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
     * Execute brainstorm moderation to select the best response(s)
     * @param context - Execution context with moderator agent
     * @param responses - Array of brainstorm responses to choose from
     * @returns The selected agents' pubkeys and optional reasoning
     */
    async executeBrainstormModeration(
        context: ExecutionContext,
        responses: BrainstormResponse[]
    ): Promise<ModerationResult | null> {
        const moderator = new BrainstormModerator(this.messageStrategy);
        return moderator.moderate(context, responses);
    }
}
