import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { LLMService, Tool } from "@/llm/types";
import type { StreamEvent } from "@/llm/types";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import { StreamPublisher } from "@/nostr/NostrPublisher";
import { buildLLMMetadata } from "@/prompts/utils/llmMetadata";
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

    constructor(
        private llmService: LLMService
    ) {
        this.repetitionDetector = new ToolRepetitionDetector();
        this.messageBuilder = new MessageBuilder();
    }

    /**
     * ExecutionBackend interface implementation
     */
    async execute(
        messages: Array<Message>,
        tools: Tool[],
        context: ExecutionContext,
        publisher: NostrPublisher
    ): Promise<void> {
        const tracingContext = createTracingContext(context.conversationId);
        this.executionLogger = createExecutionLogger(tracingContext, "agent");

        // Execute the streaming loop
        const generator = this.executeStreamingInternal(
            context,
            messages,
            tracingContext,
            publisher,
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
        publisher?: NostrPublisher,
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
        
        // Create a single StreamPublisher for the entire execution
        const streamPublisher = this.createStreamPublisher(publisher);

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
                
                // Create stream with streamPublisher in context
                const stream = this.createLLMStream(context, conversationMessages, tools, publisher, streamPublisher);

                // Process stream events for this iteration
                const iterationResult = await this.processIterationStream(
                    stream,
                    stateManager,
                    toolHandler,
                    streamPublisher,
                    publisher,
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
                    tracingLogger.debug("[ReasonActLoop] Terminal tool detected, ending loop", {
                        iteration: iterations,
                        willExitLoop: true,
                        hasDeferredEvent: !!iterationResult.deferredTerminalEvent,
                        deferredType: iterationResult.deferredTerminalEvent?.type
                    });
                    
                    // Handle deferred terminal event
                    if (iterationResult.deferredTerminalEvent) {
                        await this.publishDeferredTerminalEvent(
                            iterationResult.deferredTerminalEvent,
                            tracingLogger,
                            context
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
                    // Finalize the stream (single stable StreamPublisher)
                    await this.finalizeStream(
                        streamPublisher,
                        stateManager,
                        conversationMessages
                    );
                }
            }
            
            tracingLogger.debug("[ReasonActLoop] Exited main loop", {
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
            yield* this.handleError(error, publisher, tracingLogger, context, streamPublisher);
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
        initialStreamPublisher: StreamPublisher | undefined,
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext,
        messages: Message[]
    ): Promise<{
        events: StreamEvent[];
        isTerminal: boolean;
        hasToolCalls: boolean;
        toolResults: ToolExecutionResult[];
        assistantMessage: string;
        deferredTerminalEvent?: any;  // Single deferred event from terminal tool
    }> {
        const events: StreamEvent[] = [];
        let isTerminal = false;
        let hasToolCalls = false;
        const toolResults: ToolExecutionResult[] = [];
        let assistantMessage = "";
        const streamPublisher = initialStreamPublisher;
        let deferredTerminalEvent: any = null;
        
        for await (const event of stream) {
            tracingLogger.debug("[processIterationStream]", {
                agent: context.agent.name,
                type: event.type,
            })
            events.push(event);
            
            // If we've already detected a terminal tool, skip processing remaining events
            if (isTerminal) {
                tracingLogger.debug("[processIterationStream] Skipping event after terminal tool", {
                    eventType: event.type,
                });
                continue;
            }

            switch (event.type) {
                case "content":
                    this.handleContentEvent(event, stateManager, streamPublisher, context);
                    // Buffer content instead of streaming immediately
                    // We'll decide whether to output it after processing all events
                    assistantMessage += event.content;
                    break;

                case "tool_start":
                    // Skip tool execution if we've already detected a terminal tool
                    if (isTerminal) {
                        tracingLogger.warning("[processIterationStream] Ignoring tool_start after terminal tool", {
                            ignoredTool: event.tool,
                            args: event.args,
                        });
                        break;
                    }
                    
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
                        streamPublisher,
                        publisher,
                        event.tool,
                        event.args,
                        tracingLogger,
                        context
                    );
                    break;

                case "tool_complete": {
                    const isTerminalTool = await toolHandler.handleToolCompleteEvent(
                        event,
                        streamPublisher,
                        publisher,
                        tracingLogger,
                        context
                    );

                    // Collect tool result for next iteration
                    const toolResult = stateManager.getLastToolResult();
                    if (toolResult) {
                        toolResults.push(toolResult);
                        
                        // Check if this tool result contains deferred events
                        if (toolResult.success && toolResult.output) {
                            const output = toolResult.output as any;
                            
                            // Handle delegate/delegate_phase tools (highest priority)
                            if ((output.toolType === 'delegate' || output.toolType === 'delegate_phase')) {
                                // Tasks are now published immediately by DelegationService
                                // Just mark as terminal to end the loop
                                tracingLogger.info("[ReasonActLoop] Delegation tool detected - tasks already published", {
                                    tool: event.tool,
                                    batchId: output.batchId
                                });
                                isTerminal = true;
                            }
                            // Handle complete tool (only if we don't already have a delegation)
                            else if (output.toolType === 'complete' && output.serializedEvent) {
                                if (!deferredTerminalEvent || deferredTerminalEvent.type !== 'delegate') {
                                    tracingLogger.info("[ReasonActLoop] Complete tool detected - deferring event", {
                                        tool: event.tool,
                                        overwrites: !!deferredTerminalEvent
                                    });
                                    deferredTerminalEvent = {
                                        type: 'complete',
                                        event: output.serializedEvent
                                    };
                                    isTerminal = true;
                                } else {
                                    tracingLogger.info("[ReasonActLoop] Complete tool detected but delegation takes precedence", {
                                        tool: event.tool
                                    });
                                    isTerminal = true;
                                }
                            }
                        }
                    }

                    if (isTerminalTool && !deferredTerminalEvent) {
                        // Legacy terminal tool behavior (shouldn't happen with our updates)
                        tracingLogger.info("[ReasonActLoop] Terminal tool detected (legacy path)", {
                            tool: event.tool,
                        });
                        isTerminal = true;
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
                    this.handleErrorEvent(event, stateManager, streamPublisher, tracingLogger);
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
        streamPublisher?: StreamPublisher,
        context?: ExecutionContext
    ): void {
        stateManager.appendContent(event.content);
        
        // Extract and log reasoning if present
        this.extractAndLogReasoning(stateManager.getFullContent(), context, stateManager);
        
        // Add content to the StreamPublisher (single stable instance)
        streamPublisher?.addContent(event.content);
    }

    private handleErrorEvent(
        event: { error: string },
        stateManager: StreamStateManager,
        streamPublisher: StreamPublisher | undefined,
        tracingLogger: TracingLogger
    ): void {
        tracingLogger.error("Stream error", { error: event.error });
        stateManager.appendContent(`\n\nError: ${event.error}`);
        
        streamPublisher?.addContent(`\n\nError: ${event.error}`);
    }

    private async finalizeStream(
        streamPublisher: StreamPublisher | undefined,
        stateManager: StreamStateManager,
        messages: Message[]
    ): Promise<void> {
        if (!streamPublisher || streamPublisher.isFinalized()) return;

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

        await streamPublisher.finalize({
            llmMetadata,
            ...metadata,
        });
    }

    private createLLMStream(
        context: ExecutionContext,
        messages: Message[],
        tools?: Tool[],
        publisher?: NostrPublisher,
        streamPublisher?: StreamPublisher
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
                publisher: publisher || context.publisher,
                conversationManager: context.conversationManager,
                streamPublisher: streamPublisher,
            },
        });
    }

    private createStreamPublisher(publisher: NostrPublisher | undefined): StreamPublisher | undefined {
        if (!publisher) return undefined;
        return new StreamPublisher(publisher);
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
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext,
        streamPublisher?: StreamPublisher
    ): AsyncGenerator<StreamEvent> {
        tracingLogger.error("Streaming error", {
            error: formatAnyError(error),
            agent: context.agent.name,
        });

        if (streamPublisher && !streamPublisher.isFinalized()) {
            try {
                await streamPublisher.finalize({});
            } catch (finalizeError) {
                tracingLogger.error("Failed to finalize stream on error", {
                    error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
                });
            }
        }

        await publisher?.publishTypingIndicator("stop");

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
     * Publish a single deferred terminal event
     */
    private async publishDeferredTerminalEvent(
        deferredEvent: any,
        tracingLogger: TracingLogger,
        context: ExecutionContext
    ): Promise<void> {
        tracingLogger.info("[ReasonActLoop] Publishing deferred terminal event", {
            type: deferredEvent.type,
            eventCount: deferredEvent.type === 'delegate' ? deferredEvent.events?.length : 1
        });
        
        const { NDKEvent } = await import("@nostr-dev-kit/ndk");
        const { getNDK } = await import("@/nostr/ndkClient");
        const ndk = getNDK();
        
        // Delegation events are now published immediately by DelegationService
        // Only handle completion events here
        if (deferredEvent.type === 'complete' && deferredEvent.event) {
            // Publish completion event
            const event = new NDKEvent(ndk, deferredEvent.event);
            await event.publish();
            
            tracingLogger.info("[ReasonActLoop] Published deferred completion event", {
                eventId: event.id,
                kind: event.kind,
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