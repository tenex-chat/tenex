import type { AgentInstance } from "@/agents/types";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { providerSupportsStreaming } from "@/llm/provider-configs";
// import { getProjectContext } from "@/services/ProjectContext"; // Unused after RAL migration
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
import { RALRegistry, TimeoutResponder, isStopExecutionSignal } from "@/services/ral";
import type { PendingDelegation } from "@/services/ral/types";
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
    private pendingDelegations: PendingDelegation[] = [];

    constructor(
        private standaloneContext?: StandaloneAgentContext,
        messageStrategy?: MessageGenerationStrategy
    ) {
        this.messageStrategy = messageStrategy || new FlattenedChronologicalStrategy();
    }

    /**
     * Build a status message for delegation results
     */
    private buildDelegationStatusMessage(ralState: any): string {
        const parts: string[] = [];

        if (ralState.completedDelegations.length > 0) {
            parts.push("Delegation Results:");
            for (const completion of ralState.completedDelegations) {
                parts.push(
                    `- ${completion.recipientSlug || completion.recipientPubkey.substring(0, 8)}: ${completion.response}`
                );
            }
        }

        if (ralState.pendingDelegations.length > 0) {
            parts.push("\nStill Pending:");
            for (const pending of ralState.pendingDelegations) {
                parts.push(
                    `- ${pending.recipientSlug || pending.recipientPubkey.substring(0, 8)}: ${pending.prompt.substring(0, 80)}...`
                );
            }
        }

        return parts.join("\n");
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
                // Check RAL state before starting execution
                const ralRegistry = RALRegistry.getInstance();
                const existingRal = ralRegistry.getStateByAgent(context.agent.pubkey);

                if (existingRal?.status === "executing") {
                    // Check if this is a resumption after delegation completion
                    // (has completed delegations waiting for injection)
                    const isResumption = existingRal.completedDelegations.length > 0;

                    if (isResumption) {
                        // This is resumption after delegation - inject results and continue
                        span.addEvent("ral.resumption_after_delegation", {
                            "ral.status": "executing",
                            "ral.completed_count": existingRal.completedDelegations.length,
                            "action": "inject_results_and_continue",
                        });

                        logger.info("[AgentExecutor] Resuming after delegation completion", {
                            agent: context.agent.slug,
                            completedCount: existingRal.completedDelegations.length,
                        });

                        // Build status injection message with delegation results
                        const statusMessage = this.buildDelegationStatusMessage(existingRal);
                        ralRegistry.queueSystemMessage(context.agent.pubkey, statusMessage);

                        // Clear completed delegations after queuing
                        ralRegistry.clearCompletedDelegations(context.agent.pubkey);

                        // Fall through to continue with execution
                    } else {
                        // RAL is currently executing (not resumption) - queue for injection
                        span.addEvent("ral.already_executing", {
                            "ral.status": "executing",
                            "event.id": context.triggeringEvent.id || "",
                            "action": "queue_and_timeout",
                        });

                        logger.info("[AgentExecutor] RAL already executing, queueing event", {
                            agent: context.agent.slug,
                            eventId: context.triggeringEvent.id?.substring(0, 8),
                        });

                        ralRegistry.queueEvent(context.agent.pubkey, context.triggeringEvent);

                        // Immediately generate acknowledgment for user
                        const agentPublisher = new AgentPublisher(context.agent);
                        const busyResponder = TimeoutResponder.getInstance();
                        busyResponder.processImmediately(
                            context.agent.pubkey,
                            context.triggeringEvent,
                            context.agent,
                            agentPublisher
                        );

                        span.setStatus({ code: SpanStatusCode.OK });
                        span.end();
                        return; // Don't start new execution
                    }
                }

                if (existingRal?.status === "paused") {
                    // RAL is paused waiting for delegation - queue message for when it resumes
                    // Don't start new execution - let the delegation completion trigger resumption
                    span.addEvent("ral.paused_for_delegation", {
                        "ral.status": "paused",
                        "ral.pending_count": existingRal.pendingDelegations.length,
                        "event.id": context.triggeringEvent.id || "",
                        "action": "queue_and_acknowledge",
                    });

                    logger.info("[AgentExecutor] RAL paused for delegation, queueing event", {
                        agent: context.agent.slug,
                        eventId: context.triggeringEvent.id?.substring(0, 8),
                        pendingCount: existingRal.pendingDelegations.length,
                    });

                    ralRegistry.queueEvent(context.agent.pubkey, context.triggeringEvent);

                    // Immediately generate acknowledgment for user
                    const agentPublisher = new AgentPublisher(context.agent);
                    const busyResponder = TimeoutResponder.getInstance();
                    busyResponder.processImmediately(
                        context.agent.pubkey,
                        context.triggeringEvent,
                        context.agent,
                        agentPublisher
                    );

                    span.setStatus({ code: SpanStatusCode.OK });
                    span.end();
                    return; // Don't start new execution - wait for delegation to complete
                }

                // Create new RAL entry if none exists
                if (!existingRal) {
                    ralRegistry.create(context.agent.pubkey);
                    span.addEvent("ral.created", {
                        "action": "fresh_execution",
                    });
                    logger.debug("[AgentExecutor] Created new RAL entry", {
                        agent: context.agent.slug,
                    });
                }

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

        // Check if we paused for delegation - if so, return without publishing completion
        if (this.pendingDelegations.length > 0) {
            logger.info("[AgentExecutor] 🛑 Pausing for delegation, not publishing completion", {
                agent: context.agent.slug,
                pendingCount: this.pendingDelegations.length,
            });

            // Display pause in console
            console.log(chalk.yellow(`\n⏸️  ${context.agent.slug} paused - awaiting ${this.pendingDelegations.length} delegation(s)`));

            // Clear pending delegations now that we've handled the pause
            this.pendingDelegations = [];
            return undefined;
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

        // RAL is the single source of truth for messages during execution
        // On first iteration: build from conversation history and save to RAL
        // On subsequent iterations (recursion): use RAL messages directly
        const ralRegistry = RALRegistry.getInstance();
        let messages: ModelMessage[];

        if (ralRegistry.hasMessages(context.agent.pubkey)) {
            // Recursion: use RAL messages (includes any mid-execution injections)
            messages = ralRegistry.getMessages(context.agent.pubkey) as ModelMessage[];
            logger.info("[AgentExecutor] Using RAL messages for recursion", {
                agent: context.agent.slug,
                messageCount: messages.length,
            });
        } else {
            // First iteration: build from conversation history
            const eventFilter = sessionManager.createEventFilter();
            messages = await this.messageStrategy.buildMessages(
                context,
                context.triggeringEvent,
                eventFilter
            );
            // Save to RAL as single source of truth
            ralRegistry.saveMessages(context.agent.pubkey, messages);
            logger.info("[AgentExecutor] Built and saved initial messages to RAL", {
                agent: context.agent.slug,
                messageCount: messages.length,
            });
        }

        // Register operation with the LLM Operations Registry
        // Message injection now uses RAL as the single source of truth
        const abortSignal = llmOpsRegistry.registerOperation(context);

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

        logger.debug("[AgentExecutor] 📝 Messages ready for execution", {
            messageCount: messages.length,
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

        try {
            // Capture the current span for use in prepareStep callback
            // prepareStep is called synchronously by AI SDK and may not have access to OTel context
            const executionSpan = trace.getActiveSpan();

            // Create prepareStep callback for message injection from RAL queue (SYNC)
            // RAL is the single source of truth - injections are persisted to RAL.messages
            // and also returned here for the current step
            const prepareStep = (
                step: { messages: ModelMessage[]; stepNumber: number }
            ): { messages?: ModelMessage[] } | undefined => {
                const ralRegistry = RALRegistry.getInstance();

                // Get newly queued injections - they're also persisted to RAL.messages for recursion
                const newInjections = ralRegistry.getAndPersistInjections(context.agent.pubkey);

                if (newInjections.length === 0) {
                    return undefined;
                }

                logger.info(`[prepareStep] Injecting ${newInjections.length} message(s) from RAL queue`, {
                    agent: context.agent.slug,
                    stepNumber: step.stepNumber,
                    messageTypes: newInjections.map((q) => q.type),
                });

                // Convert to model messages
                const injectedMessages: ModelMessage[] = newInjections.map((q) => ({
                    role: q.type as "user" | "system",
                    content: q.content,
                }));

                // Add trace event
                if (executionSpan) {
                    executionSpan.addEvent("ral_injection.process", {
                        "injection.message_count": newInjections.length,
                        "injection.step_number": step.stepNumber,
                        "injection.types": newInjections.map((q) => q.type).join(","),
                        "agent.slug": context.agent.slug,
                    });
                }

                return {
                    messages: [...step.messages, ...injectedMessages],
                };
            };

            // Create onStopCheck to detect delegation stop signals
            const onStopCheck = async (steps: any[]): Promise<boolean> => {
                if (steps.length === 0) return false;

                const lastStep = steps[steps.length - 1];
                const toolResults = lastStep.toolResults ?? [];

                logger.debug("[AgentExecutor] onStopCheck called", {
                    stepCount: steps.length,
                    toolResultCount: toolResults.length,
                    toolNames: toolResults.map((r: any) => r.toolName),
                });

                for (const toolResult of toolResults) {
                    // AI SDK uses `output` for tool results, not `result`
                    const hasStopSignal = isStopExecutionSignal(toolResult.output);
                    logger.debug("[AgentExecutor] Checking tool result", {
                        toolName: toolResult.toolName,
                        hasStopSignal,
                        resultType: typeof toolResult.output,
                        resultKeys: toolResult.output && typeof toolResult.output === "object"
                            ? Object.keys(toolResult.output)
                            : [],
                    });

                    if (hasStopSignal) {
                        logger.info("[AgentExecutor] Detected delegation stop signal", {
                            agent: context.agent.slug,
                            delegationCount: toolResult.output.pendingDelegations.length,
                        });

                        // Store pending delegations for later handling
                        this.pendingDelegations = toolResult.output.pendingDelegations;
                        return true; // Stop execution
                    }
                }

                return false;
            };

            // Publish empty 21111 to signal execution start (implicit typing indicator)
            await agentPublisher.publishStreamingDelta("", eventContext, false);

            await llmService.stream(messages, toolsObject, { abortSignal, prepareStep, onStopCheck });
        } catch (streamError) {
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

        // Handle RAL state based on finish reason and pending delegations
        if (this.pendingDelegations.length > 0) {
            // Stopped for delegation - save state and pause
            // NOTE: Don't clear pendingDelegations here - executeWithSupervisor needs to check it
            logger.info("[AgentExecutor] Saving RAL state for delegation pause", {
                agent: context.agent.slug,
                pendingCount: this.pendingDelegations.length,
                messageCount: messages.length,
            });

            ralRegistry.saveState(context.agent.pubkey, messages, this.pendingDelegations);
        } else if (completionEvent?.finishReason === "stop" || completionEvent?.finishReason === "end") {
            // Normal completion - clear RAL state
            logger.info("[AgentExecutor] Clearing RAL state after normal completion", {
                agent: context.agent.slug,
                finishReason: completionEvent.finishReason,
            });

            ralRegistry.clear(context.agent.pubkey);
        }

        return completionEvent;
    }

}
