import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { LLMService, Tool } from "@/llm/types";
import type { StreamEvent } from "@/llm/types";
import { buildLLMMetadata } from "@/prompts/utils/llmMetadata";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { AgentStreamer } from "@/nostr/AgentStreamer";
import type { CompletionIntent, DelegationIntent, EventContext } from "@/nostr/AgentEventEncoder";
import type { StreamHandle } from "@/nostr/AgentStreamer";
import type { TracingContext, TracingLogger } from "@/tracing";
import { createTracingLogger, createTracingContext } from "@/tracing";
import { Message } from "multi-llm-ts";
import type { ExecutionContext } from "./types";
import { createExecutionLogger, type ExecutionLogger } from "@/logging/ExecutionLogger";
import { StreamStateManager } from "./StreamStateManager";
import { ToolStreamHandler } from "./ToolStreamHandler";
import { TerminationHandler } from "./TerminationHandler";
import { ToolRepetitionDetector } from "./ToolRepetitionDetector";
import type { ToolExecutionResult } from "@/tools/executor";
import { MessageBuilder } from "@/conversations/MessageBuilder";

// Maximum iterations to prevent infinite loops
const MAX_ITERATIONS = 20;

/**
 * ReasonActLoop implementation that properly implements the Reason-Act-Observe pattern.
 * Iteratively calls the LLM, executes tools, and feeds results back for further reasoning.
 */
export class ReasonActLoop {
    private executionLogger?: ExecutionLogger;
    private repetitionDetector: ToolRepetitionDetector;
    private messageBuilder: MessageBuilder;
    private startTime?: number;
    private agentPublisher!: AgentPublisher;
    private agentStreamer!: AgentStreamer;

    constructor(
        private llmService: LLMService
    ) {
        this.repetitionDetector = new ToolRepetitionDetector();
        this.messageBuilder = new MessageBuilder();
        // AgentPublisher and AgentStreamer will be initialized in execute() when we have the agent
    }

    /**
     * ExecutionBackend interface implementation
     */
    async execute(
        messages: Array<Message>,
        tools: Tool[],
        context: ExecutionContext
    ): Promise<void> {
        this.startTime = Date.now();
        const tracingContext = createTracingContext(context.conversationId);
        this.executionLogger = createExecutionLogger(tracingContext, "agent");
        
        // Initialize AgentPublisher and AgentStreamer with the agent from context
        this.agentPublisher = new AgentPublisher(context.agent, context.conversationManager);
        this.agentStreamer = new AgentStreamer(this.agentPublisher);

        // Execute the streaming loop
        const generator = this.executeStreamingInternal(
            context,
            messages,
            tracingContext,
            tools
        );

        // Drain the generator
        let iterResult: IteratorResult<StreamEvent, void>;
        do {
            iterResult = await generator.next();
        } while (!iterResult.done);
    }

    async *executeStreamingInternal(
        context: ExecutionContext,
        messages: Message[],
        tracingContext: TracingContext,
        tools?: Tool[]
    ): AsyncGenerator<StreamEvent, void, unknown> {
        const tracingLogger = createTracingLogger(tracingContext, "agent");
        
        // Initialize handlers
        const stateManager = new StreamStateManager();
        const toolHandler = new ToolStreamHandler(stateManager, this.executionLogger);
        const terminationHandler = new TerminationHandler(stateManager);

        this.logExecutionStart(tracingLogger, context, tools);

        // Track conversation messages for the iterative loop
        const conversationMessages = [...messages];
        let iterations = 0;
        let isComplete = false;
        
        // Create a stream handle for the entire execution
        const streamHandle = this.createStreamHandle(context);

        try {
            // Main Reason-Act-Observe loop
            while (!isComplete && iterations < MAX_ITERATIONS) {
                iterations++;
                tracingLogger.info("[ReasonActLoop] Starting iteration", {
                    iteration: iterations,
                    isComplete,
                    messageCount: conversationMessages.length,
                    lastMessage: conversationMessages[conversationMessages.length-1].content.substring(0, 100)
                });
                
                // Create stream with streamHandle in context
                const stream = this.createLLMStream(context, conversationMessages, tools);

                // Process stream events for this iteration
                const iterationResult = await this.processIterationStream(
                    stream,
                    stateManager,
                    toolHandler,
                    streamHandle,
                            tracingLogger,
                    context,
                    conversationMessages
                );

                // Yield events from this iteration
                for (const event of iterationResult.events) {
                    yield event;
                }

                // Check if we should continue iterating
                if (iterationResult.isTerminal) {
                    tracingLogger.info("[ReasonActLoop] Terminal tool detected, ending loop", {
                        iteration: iterations,
                        willExitLoop: true,
                        hasDeferredEvent: !!iterationResult.deferredTerminalEvent,
                        deferredType: iterationResult.deferredTerminalEvent?.type
                    });
                    
                    // Handle deferred terminal event
                    if (iterationResult.deferredTerminalEvent) {
                        await this.publishTerminalIntent(
                            iterationResult.deferredTerminalEvent,
                            tracingLogger,
                            context,
                            stateManager
                        );
                    }
                    
                    isComplete = true;
                } else if (iterationResult.hasToolCalls) {
                    // Add tool results to conversation for next iteration
                    this.addToolResultsToConversation(
                        conversationMessages,
                        iterationResult.toolResults,
                        iterationResult.assistantMessage,
                        tracingLogger
                    );
                } else if (iterationResult.assistantMessage.trim().length > 0) {
                    // Agent generated content but no tool calls or terminal tool
                    // This means the agent has provided a textual response - we should complete
                    conversationMessages.push(new Message("assistant", iterationResult.assistantMessage));
                    tracingLogger.debug("[ReasonActLoop] Agent generated content, completing", {
                        iteration: iterations,
                        contentLength: iterationResult.assistantMessage.length,
                    });
                    isComplete = true; // Complete after generating a response
                } else {
                    // No tool calls, no terminal tool, AND no content was generated
                    // This indicates the agent truly has nothing further to do
                    tracingLogger.debug("[ReasonActLoop] No tool calls, no content, ending loop", {
                        iteration: iterations,
                    });
                    isComplete = true;
                }

                // Finalize stream for this iteration
                // Skip finalization if a terminal tool already published its response
                if (!iterationResult.isTerminal) {
                    // Finalize the stream (single stable StreamHandle)
                    await this.finalizeStream(
                        streamHandle,
                        stateManager,
                        conversationMessages
                    );
                }
            }
            
            tracingLogger.info("[ReasonActLoop] Exited main loop", {
                iterations,
                isComplete,
                reason: isComplete ? "completed" : "max iterations",
            });

            if (iterations >= MAX_ITERATIONS && !isComplete) {
                const error = new Error(`Agent ${context.agent.name} reached maximum iterations (${MAX_ITERATIONS}) without completing task`);
                tracingLogger.error("[ReasonActLoop] Maximum iterations reached without completion", {
                    maxIterations: MAX_ITERATIONS,
                    agent: context.agent.name,
                    phase: context.phase,
                });
                throw error;
            }

            // Check if agent completed properly (just log, don't retry)
            terminationHandler.checkTermination(context, tracingLogger);

            yield this.createFinalEvent(stateManager);

        } catch (error) {
            yield* this.handleError(error, tracingLogger, context, streamHandle);
            throw error;
        }
    }

    /**
     * Process a single iteration of the stream and collect results
     */
    private async processIterationStream(
        stream: AsyncIterable<StreamEvent>,
        stateManager: StreamStateManager,
        toolHandler: ToolStreamHandler,
        streamHandle: StreamHandle | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext,
        messages: Message[]
    ): Promise<{
        events: StreamEvent[];
        isTerminal: boolean;
        hasToolCalls: boolean;
        toolResults: ToolExecutionResult[];
        assistantMessage: string;
        deferredTerminalEvent?: { type: string; intent: CompletionIntent | DelegationIntent };
    }> {
        const events: StreamEvent[] = [];
        let isTerminal = false;
        let hasToolCalls = false;
        const toolResults: ToolExecutionResult[] = [];
        let assistantMessage = "";
        let deferredTerminalEvent: { type: string; intent: CompletionIntent | DelegationIntent } | null = null;
        
        for await (const event of stream) {
            tracingLogger.debug("[processIterationStream]", {
                agent: context.agent.name,
                type: event.type,
            })
            events.push(event);
            
            // If we've already detected a terminal tool, break out of stream processing
            if (isTerminal) {
                tracingLogger.debug("[processIterationStream] Breaking stream processing after terminal tool", {
                    eventType: event.type,
                });
                break;
            }

            switch (event.type) {
                case "content":
                    this.handleContentEvent(event, stateManager, streamHandle, context);
                    // Buffer content instead of streaming immediately
                    // We'll decide whether to output it after processing all events
                    assistantMessage += event.content;
                    break;

                case "tool_start": {
                    hasToolCalls = true;
                    
                    // Check for repetitive tool calls
                    const warningMessage = this.repetitionDetector.checkRepetition(
                        event.tool, 
                        event.args
                    );
                    if (warningMessage) {
                        const systemMessage = this.messageBuilder.formatSystemMessage(warningMessage, "Tool Repetition Detector");
                        messages.push(systemMessage);
                    }
                    
                    await toolHandler.handleToolStartEvent(
                        streamHandle,
                                    event.tool,
                        event.args,
                        tracingLogger,
                        context
                    );
                    break;
                }

                case "tool_complete": {
                    const isTerminalTool = await toolHandler.handleToolCompleteEvent(
                        event,
                        streamHandle,
                                    tracingLogger,
                        context
                    );

                    // Collect tool result for next iteration
                    const toolResult = stateManager.getLastToolResult();
                    if (toolResult) {
                        toolResults.push(toolResult);
                        
                        // Check if this tool result contains an intent
                        if (toolResult.success && toolResult.output) {
                            const output = toolResult.output as { type?: string; [key: string]: unknown };
                            
                            // Check if output is an intent (has 'type' field)
                            if (output.type === 'completion' || output.type === 'delegation') {
                                tracingLogger.info("[ReasonActLoop] Terminal intent detected", {
                                    tool: event.tool,
                                    intentType: output.type
                                });
                                isTerminal = true;
                                deferredTerminalEvent = {
                                    type: output.type,
                                    intent: output as unknown as CompletionIntent | DelegationIntent
                                };
                            }
                        }
                    }

                    // If the tool handler detected this as a terminal tool, mark as terminal
                    if (isTerminalTool) {
                        isTerminal = true;
                        
                        // If no deferred event was created, create a basic one
                        if (!deferredTerminalEvent && toolResult?.success && toolResult?.output) {
                            const output = toolResult.output as { type?: string; [key: string]: unknown };
                            if (output.type === 'completion' || output.type === 'delegation') {
                                deferredTerminalEvent = {
                                    type: output.type,
                                    intent: output as unknown as CompletionIntent | DelegationIntent
                                };
                            }
                        }
                    }
                    break;
                }

                case "done":
                    if (event.response) {
                        stateManager.setFinalResponse(event.response);
                        // Log LLM metadata for debugging
                        tracingLogger.debug("[ReasonActLoop] Received 'done' event", {
                            hasResponse: !!event.response,
                            model: event.response.model,
                            hasUsage: !!event.response.usage,
                            promptTokens: event.response.usage?.prompt_tokens,
                            completionTokens: event.response.usage?.completion_tokens,
                        });
                    }
                    break;

                case "error":
                    this.handleErrorEvent(event, stateManager, streamHandle, tracingLogger);
                    break;
            }
        }

        
        return {
            events,
            isTerminal,
            hasToolCalls,
            toolResults,
            assistantMessage: assistantMessage.trim(),
            deferredTerminalEvent: deferredTerminalEvent || undefined,
        };
    }

    /**
     * Add tool results back to the conversation for the next iteration
     */
    private addToolResultsToConversation(
        messages: Message[],
        toolResults: ToolExecutionResult[],
        assistantMessage: string,
        tracingLogger: TracingLogger
    ): void {
        // Add the assistant's message (with reasoning and tool calls)
        if (assistantMessage) {
            const message = this.messageBuilder.formatAssistantMessage(assistantMessage);
            messages.push(message);
        }

        // Add tool results as user messages for the next iteration
        for (const result of toolResults) {
            const toolResultMessage = this.formatToolResultAsString(result);
            // Use MessageBuilder to create properly formatted user message
            const message = this.messageBuilder.formatUserMessage(toolResultMessage);
            messages.push(message);
            
            tracingLogger.info("[ReasonActLoop] Added tool result to conversation", {
                success: result.success,
                resultLength: toolResultMessage.length,
            });
        }
    }

    /**
     * Format a tool result as a string for inclusion in the conversation
     */
    private formatToolResultAsString(result: ToolExecutionResult): string {
        if (result.success) {
            // Format the output as a string
            const output = result.output;
            if (typeof output === "string") {
                return `Tool result: ${output}`;
            } else if (output !== undefined && output !== null) {
                return `Tool result: ${JSON.stringify(output)}`;
            } else {
                return `Tool result: Success`;
            }
        } else {
            return `Tool error: ${result.error?.message || "Unknown error"}`;
        }
    }


    /**
     * Handle the done event with metadata processing
     */

    private handleContentEvent(
        event: { content: string },
        stateManager: StreamStateManager,
        streamHandle?: StreamHandle,
        context?: ExecutionContext
    ): void {
        stateManager.appendContent(event.content);
        
        // Extract and log reasoning if present
        this.extractAndLogReasoning(stateManager.getFullContent(), context, stateManager);
        
        // Add content to the stream handle
        streamHandle?.addContent(event.content);
    }

    private handleErrorEvent(
        event: { error: string },
        stateManager: StreamStateManager,
        streamHandle: StreamHandle | undefined,
        tracingLogger: TracingLogger
    ): void {
        tracingLogger.error("Stream error", { error: event.error });
        stateManager.appendContent(`\n\nError: ${event.error}`);
        
        streamHandle?.addContent(`\n\nError: ${event.error}`);
    }

    private async finalizeStream(
        streamHandle: StreamHandle | undefined,
        stateManager: StreamStateManager,
        messages: Message[]
    ): Promise<void> {
        if (!streamHandle) return;

        const finalResponse = stateManager.getFinalResponse();
        const llmMetadata = finalResponse
            ? await buildLLMMetadata(finalResponse, messages)
            : undefined;

        // Build metadata for finalization
        const metadata: Record<string, unknown> = {};
        const termination = stateManager.getTermination();
        
        if (termination) {
            metadata.completeMetadata = termination;
        }

        if (llmMetadata) {
            metadata.model = llmMetadata.model;
            metadata.usage = llmMetadata.usage;
            
            // Get tool calls from tool results
            const toolResults = stateManager.getToolResults();
            const toolCalls = toolResults.map(result => ({
                name: result.toolName,
                arguments: result.toolArgs
            }));
            metadata.toolCalls = toolCalls.length > 0 ? toolCalls : undefined;
            metadata.executionTime = this.startTime ? Date.now() - this.startTime : undefined;
        }

        await streamHandle.finalize(metadata);
    }

    private createLLMStream(
        context: ExecutionContext,
        messages: Message[],
        tools?: Tool[],
    ): ReturnType<LLMService["stream"]> {
        // Log what we're sending to the LLM
        logger.debug("[ReasonActLoop] Calling LLM stream", {
            agent: context.agent.name,
            phase: context.phase,
            messageCount: messages.length,
            toolCount: tools?.length || 0,
            toolNames: tools?.map(t => t.name).join(", ") || "none",
        });
        
        // Log the actual messages being sent
        messages.forEach((msg, index) => {
            const preview = msg.content.length > 200 
                ? msg.content.substring(0, 200) + "..." 
                : msg.content;
            logger.debug(`[ReasonActLoop] Message ${index + 1}/${messages.length}`, {
                role: msg.role,
                contentLength: msg.content.length,
                preview,
            });
        });
        
        return this.llmService.stream({
            messages,
            options: {
                configName: context.agent.llmConfig,
                agentName: context.agent.name,
            },
            tools,
            toolContext: {
                ...context,
                conversationManager: context.conversationManager,
            },
        });
    }

    private createStreamHandle(context: ExecutionContext): StreamHandle | undefined {
        // Get conversation for the event context
        const conversation = context.conversationManager.getConversation(context.conversationId);
        
        // Build event context for streaming
        const eventContext: EventContext = {
            triggeringEvent: context.triggeringEvent,
            conversationEvent: conversation ? conversation.history[0] : undefined // Root event is first in history
        };
        
        return this.agentStreamer.createStreamHandle(eventContext);
    }

    private createFinalEvent(stateManager: StreamStateManager): StreamEvent {
        const baseEvent: StreamEvent = {
            type: "done",
            response: stateManager.getFinalResponse() || {
                type: "text",
                content: stateManager.getFullContent(),
                toolCalls: [],
            },
        };

        // Add additional properties for AgentExecutor
        return Object.assign(baseEvent, {
            termination: stateManager.getTermination(),
        }) as StreamEvent;
    }

    private async *handleError(
        error: unknown,
        tracingLogger: TracingLogger,
        context: ExecutionContext,
        streamHandle?: StreamHandle
    ): AsyncGenerator<StreamEvent> {
        tracingLogger.error("Streaming error", {
            error: formatAnyError(error),
            agent: context.agent.name,
        });

        if (streamHandle) {
            try {
                await streamHandle.finalize({});
            } catch (finalizeError) {
                tracingLogger.error("Failed to finalize stream on error", {
                    error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
                });
            }
        }

        // Stop typing indicator using AgentPublisher
        try {
            const conversation = context.conversationManager.getConversation(context.conversationId);
            const eventContext: EventContext = {
                triggeringEvent: context.triggeringEvent,
                conversationEvent: conversation ? conversation.history[0] : undefined
            };
            await this.agentPublisher.typing({ type: 'typing', state: 'stop' }, eventContext);
        } catch (typingError) {
            tracingLogger.warning("Failed to stop typing indicator", { error: formatAnyError(typingError) });
        }

        yield {
            type: "error",
            error: formatAnyError(error),
        };
    }

    private logExecutionStart(
        tracingLogger: TracingLogger,
        context: ExecutionContext,
        tools?: Tool[]
    ): void {
        tracingLogger.info("🔄 Starting ReasonActLoop", {
            agent: context.agent.name,
            phase: context.phase,
            tools: tools?.map((t) => t.name).join(", "),
        });
    }

    /**
     * Publish a terminal intent using AgentPublisher
     */
    private async publishTerminalIntent(
        deferredEvent: { type: string; intent: CompletionIntent | DelegationIntent },
        tracingLogger: TracingLogger,
        context: ExecutionContext,
        stateManager: StreamStateManager
    ): Promise<void> {
        tracingLogger.info("[ReasonActLoop] Publishing terminal intent", {
            type: deferredEvent.type
        });
        
        const agentPublisher = new AgentPublisher(context.agent);
        const intent = deferredEvent.intent;
        
        // Build event context with execution metadata
        // Get tool calls from tool results
        const toolResults = stateManager.getToolResults();
        const toolCalls = toolResults.map(result => ({
            name: result.toolName,
            arguments: result.toolArgs
        }));
        
        // Check if this is completing a delegated task using DelegationRegistry
        let delegatingAgentPubkey: string | undefined;
        
        tracingLogger.debug("[ReasonActLoop] Checking for delegation context", {
            triggeringEventKind: context.triggeringEvent.kind,
            triggeringEventId: context.triggeringEvent.id?.substring(0, 8),
            fullTriggeringEventId: context.triggeringEvent.id,
            isNDKTask: context.triggeringEvent.kind === 1934
        });
        
        if (context.triggeringEvent.kind === 1934) { // NDKTask.kind
            const delegationContext = context.conversationManager.getDelegationContext(context.triggeringEvent.id);
            if (delegationContext) {
                delegatingAgentPubkey = delegationContext.delegatingAgent.pubkey;
                tracingLogger.debug("[ReasonActLoop] Found delegation context", {
                    taskId: context.triggeringEvent.id.substring(0, 8),
                    delegatingAgent: delegationContext.delegatingAgent.slug,
                    delegatingAgentPubkey: delegatingAgentPubkey.substring(0, 16),
                    batchId: delegationContext.delegationBatchId
                });
            } else {
                tracingLogger.warning("[ReasonActLoop] No delegation context found for NDKTask", {
                    taskId: context.triggeringEvent.id?.substring(0, 8),
                    fullTaskId: context.triggeringEvent.id
                });
            }
        } else {
            tracingLogger.debug("[ReasonActLoop] Not an NDKTask, skipping delegation lookup", {
                eventKind: context.triggeringEvent.kind
            });
        }
        
        // Get conversation for the event context
        const conversation = context.conversationManager.getConversation(context.conversationId);
        
        const eventContext: EventContext = {
            triggeringEvent: context.triggeringEvent,
            conversationEvent: conversation ? conversation.history[0] : undefined, // Root event is first in history
            delegatingAgentPubkey,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            executionTime: this.startTime ? Date.now() - this.startTime : undefined,
            model: stateManager.getFinalResponse()?.model,
            usage: stateManager.getFinalResponse()?.usage,
            phase: context.phase
        };
        
        // Publish based on intent type
        if (intent.type === 'completion') {
            const event = await agentPublisher.complete(intent as CompletionIntent, eventContext);
            tracingLogger.info("[ReasonActLoop] Published completion event", {
                eventId: event.id
            });
        } else if (intent.type === 'delegation') {
            const result = await agentPublisher.delegate(intent as DelegationIntent, eventContext);
            tracingLogger.info("[ReasonActLoop] Published delegation events", {
                batchId: result.batchId,
                taskCount: result.tasks.length
            });
        }
    }

    private extractAndLogReasoning(content: string, context?: ExecutionContext, stateManager?: StreamStateManager): void {
        if (!this.executionLogger || !context || !stateManager) return;
        
        // Extract thinking content
        const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/g);
        if (!thinkingMatch) return;
        
        // Process each thinking block
        thinkingMatch.forEach(block => {
            const contentMatch = block.match(/<thinking>([\s\S]*?)<\/thinking>/);
            if (!contentMatch || !contentMatch[1]) return;
            
            const thinkingContent = contentMatch[1].trim();
            
            // Check if this block has already been logged
            if (stateManager.hasThinkingBlockBeenLogged(thinkingContent)) {
                return; // Skip already logged blocks
            }
            
            // Mark this block as logged
            stateManager.markThinkingBlockLogged(thinkingContent);
            
            // Previously parsed reasoning data here but no longer needed
        });
    }

}