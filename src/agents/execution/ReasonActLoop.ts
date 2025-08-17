import { formatAnyError } from "@/utils/error-formatter";
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
import type { ToolExecutionResult } from "@/tools/executor";

// Maximum iterations to prevent infinite loops
const MAX_ITERATIONS = 20;

// Track recent tool calls to detect repetition
interface ToolCallRecord {
    tool: string;
    args: string; // JSON stringified for comparison
    timestamp: number;
}

/**
 * ReasonActLoop implementation that properly implements the Reason-Act-Observe pattern.
 * Iteratively calls the LLM, executes tools, and feeds results back for further reasoning.
 */
export class ReasonActLoop {
    private executionLogger?: ExecutionLogger;
    private streamingBuffer: Map<string, string> = new Map();
    private lastLoggedChunk: Map<string, string> = new Map();
    private recentToolCalls: ToolCallRecord[] = [];
    private readonly MAX_TOOL_HISTORY = 10;
    private readonly REPETITION_THRESHOLD = 3;

    constructor(
        private llmService: LLMService
    ) {}

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

        try {
            // Main Reason-Act-Observe loop
            while (!isComplete && iterations < MAX_ITERATIONS) {
                iterations++;
                tracingLogger.info("[ReasonActLoop] Starting iteration", {
                    iteration: iterations,
                    messageCount: conversationMessages.length,
                    lastMessage: conversationMessages[conversationMessages.length-1].content.substring(0, 100)
                });

                // Create and process stream for this iteration
                const stream = this.createLLMStream(context, conversationMessages, tools, publisher);
                const streamPublisher = this.createStreamPublisher(publisher);
                
                if (streamPublisher) {
                    stateManager.setStreamPublisher(streamPublisher);
                }

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
                    tracingLogger.info("[ReasonActLoop] Terminal tool detected, ending loop", {
                        iteration: iterations,
                    });
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
                    // This means the agent has provided a textual response based on previous actions/tools
                    conversationMessages.push(new Message("assistant", iterationResult.assistantMessage));
                    tracingLogger.info("[ReasonActLoop] Agent generated content, continuing loop", {
                        iteration: iterations,
                        contentLength: iterationResult.assistantMessage.length,
                    });
                    // Loop continues for next iteration
                } else {
                    // No tool calls, no terminal tool, AND no content was generated
                    // This indicates the agent truly has nothing further to do
                    tracingLogger.info("[ReasonActLoop] No tool calls, no content, ending loop", {
                        iteration: iterations,
                    });
                    isComplete = true;
                }

                // Finalize stream for this iteration
                await this.finalizeStream(
                    streamPublisher,
                    stateManager,
                    context,
                    conversationMessages
                );
            }

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
            yield* this.handleError(error, publisher, stateManager, tracingLogger, context);
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
    }> {
        const events: StreamEvent[] = [];
        let isTerminal = false;
        let hasToolCalls = false;
        const toolResults: ToolExecutionResult[] = [];
        let assistantMessage = "";
        let streamPublisher = initialStreamPublisher;
        
        // Initialize streaming buffer for this agent
        const agentKey = `${context.agent.name}`;
        this.streamingBuffer.set(agentKey, "");
        
        for await (const event of stream) {
            tracingLogger.info("[processIterationStream]", {
                agent: context.agent.name,
                type: event.type,
            })
            events.push(event);

            switch (event.type) {
                case "content":
                    this.handleContentEvent(event, stateManager, streamPublisher, context);
                    this.updateStreamingLog(agentKey, event.content);
                    assistantMessage += event.content;
                    break;

                case "tool_start":
                    hasToolCalls = true;
                    
                    // Check for repetitive tool calls
                    const repetitionWarning = this.checkToolRepetition(
                        event.tool, 
                        event.args,
                        messages
                    );
                    
                    await toolHandler.handleToolStartEvent(
                        streamPublisher,
                        publisher,
                        event.tool,
                        event.args,
                        tracingLogger,
                        context
                    );
                    // Update streamPublisher reference if a new one was created
                    streamPublisher = stateManager.getStreamPublisher() || streamPublisher;
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
                    }

                    if (isTerminalTool) {
                        tracingLogger.info("[ReasonActLoop] Terminal tool detected in iteration", {
                            tool: event.tool,
                        });
                        isTerminal = true;
                        // Continue processing to capture metadata
                    }
                    break;
                }

                case "done":
                    if (event.response) {
                        stateManager.setFinalResponse(event.response);
                        this.handleDoneEvent(event, stateManager, publisher, tracingLogger, context, messages);
                    }
                    // Clear the streaming line for this agent
                    this.clearStreamingLog(agentKey);
                    break;

                case "error":
                    this.handleErrorEvent(event, stateManager, streamPublisher, tracingLogger, context);
                    // Clear the streaming line for this agent
                    this.clearStreamingLog(agentKey);
                    break;
            }
        }

        return {
            events,
            isTerminal,
            hasToolCalls,
            toolResults,
            assistantMessage: assistantMessage.trim(),
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
            messages.push(new Message("assistant", assistantMessage));
        }

        // Add tool results as user messages for the next iteration
        for (const result of toolResults) {
            const toolResultMessage = this.formatToolResultMessage(result);
            messages.push(new Message("user", toolResultMessage));
            
            tracingLogger.info("[ReasonActLoop] Added tool result to conversation", {
                success: result.success,
                resultLength: toolResultMessage.length,
            });
        }
    }

    /**
     * Format a tool result for inclusion in the conversation
     */
    private formatToolResultMessage(result: ToolExecutionResult): string {
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
    private handleDoneEvent(
        event: { response?: any },
        stateManager: StreamStateManager,
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext,
        messages: Message[]
    ): void {
        tracingLogger.info("[ReasonActLoop] Received 'done' event", {
            hasResponse: !!event.response,
            model: event.response?.model,
            hasUsage: !!event.response?.usage,
            promptTokens: event.response?.usage?.prompt_tokens,
            completionTokens: event.response?.usage?.completion_tokens,
            cost: event.response?.usage?.total_cost_usd,
        });
        
        // Check for deferred event from complete() tool
        const serializedEvent = stateManager.getDeferredEvent();
        if (serializedEvent && publisher) {
            this.processDeferredEvent(
                serializedEvent,
                event.response,
                publisher,
                tracingLogger,
                context,
                messages
            );
        }
    }

    /**
     * Process deferred event from complete() tool
     */
    private async processDeferredEvent(
        serializedEvent: any,
        response: any,
        publisher: NostrPublisher,
        tracingLogger: TracingLogger,
        context: ExecutionContext,
        messages: Message[]
    ): Promise<void> {
        tracingLogger.info("[ReasonActLoop] Processing deferred event", {
            serializedEventKeys: Object.keys(serializedEvent),
            contentLength: serializedEvent.content?.length || 0,
        });
        
        // Reconstruct the NDKEvent from serialized form
        const { NDKEvent } = await import("@nostr-dev-kit/ndk");
        const { getNDK } = await import("@/nostr/ndkClient");
        const deferredEvent = new NDKEvent(getNDK(), serializedEvent);
        
        // Build and add LLM metadata
        const metadata = await buildLLMMetadata(response, messages);
        
        tracingLogger.info("[ReasonActLoop] Adding metadata to deferred event", {
            model: metadata?.model,
            cost: metadata?.cost,
            promptTokens: metadata?.promptTokens,
            completionTokens: metadata?.completionTokens,
            hasSystemPrompt: !!metadata?.systemPrompt,
            hasUserPrompt: !!metadata?.userPrompt,
        });
        
        publisher.addLLMMetadata(deferredEvent, metadata);
        
        // Sign and publish with full metadata
        await deferredEvent.sign(context.agent.signer);
        await deferredEvent.publish();
        
        tracingLogger.info("[ReasonActLoop] ✅ Published deferred complete() event with metadata", {
            eventId: deferredEvent.id,
            hasMetadata: !!metadata,
            model: metadata?.model,
            cost: metadata?.cost,
            totalTokens: metadata?.totalTokens,
        });
    }


    private handleContentEvent(
        event: { content: string },
        stateManager: StreamStateManager,
        streamPublisher?: StreamPublisher,
        context?: ExecutionContext
    ): void {
        stateManager.appendContent(event.content);
        
        // Extract and log reasoning if present
        this.extractAndLogReasoning(stateManager.getFullContent(), context, stateManager);
        
        // Orchestrator should remain silent
        if (!context?.agent.isOrchestrator) {
            streamPublisher?.addContent(event.content);
        }
    }

    private handleErrorEvent(
        event: { error: string },
        stateManager: StreamStateManager,
        streamPublisher: StreamPublisher | undefined,
        tracingLogger: TracingLogger,
        context?: ExecutionContext
    ): void {
        tracingLogger.error("Stream error", { error: event.error });
        stateManager.appendContent(`\n\nError: ${event.error}`);
        
        // Orchestrator should remain silent
        if (!context?.agent.isOrchestrator) {
            streamPublisher?.addContent(`\n\nError: ${event.error}`);
        }
    }

    private async finalizeStream(
        streamPublisher: StreamPublisher | undefined,
        stateManager: StreamStateManager,
        context: ExecutionContext,
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

        // Only finalize if there's content or metadata
        if (!context.agent.isOrchestrator || termination) {
            await streamPublisher.finalize({
                llmMetadata,
                ...metadata,
            });
        }
    }

    private createLLMStream(
        context: ExecutionContext,
        messages: Message[],
        tools?: Tool[],
        publisher?: NostrPublisher
    ): ReturnType<LLMService["stream"]> {
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
        stateManager: StreamStateManager,
        tracingLogger: TracingLogger,
        context: ExecutionContext
    ): AsyncGenerator<StreamEvent> {
        tracingLogger.error("Streaming error", {
            error: formatAnyError(error),
            agent: context.agent.name,
        });

        const streamPublisher = stateManager.getStreamPublisher();
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

    private updateStreamingLog(agentKey: string, content: string): void {
        // Only log the new chunk, not the entire buffer
        if (content.trim()) {
            // Simple approach: just log each chunk as it arrives
            // This avoids the complexity of trying to update in place
            process.stdout.write(content);
        }
        
        // Still track the full buffer for debugging if needed
        const currentBuffer = this.streamingBuffer.get(agentKey) || "";
        this.streamingBuffer.set(agentKey, currentBuffer + content);
    }
    
    private clearStreamingLog(agentKey: string): void {
        // Just clean up and add a newline
        if (this.streamingBuffer.has(agentKey)) {
            // Add a newline to separate from next output
            process.stdout.write('\n');
            this.streamingBuffer.delete(agentKey);
            this.lastLoggedChunk.delete(agentKey);
        }
    }
    
    /**
     * Check if a tool call is being repeated excessively
     * Adds a warning message to the conversation if repetition is detected
     */
    private checkToolRepetition(
        tool: string, 
        args: any,
        messages: Message[]
    ): string | null {
        const argsStr = JSON.stringify(args);
        const now = Date.now();
        
        // Add current call to history
        this.recentToolCalls.push({ tool, args: argsStr, timestamp: now });
        
        // Keep history size limited
        if (this.recentToolCalls.length > this.MAX_TOOL_HISTORY) {
            this.recentToolCalls.shift();
        }
        
        // Count similar recent calls (same tool and args within last 10 calls)
        const similarCalls = this.recentToolCalls.filter(
            call => call.tool === tool && call.args === argsStr
        );
        
        if (similarCalls.length >= this.REPETITION_THRESHOLD) {
            // Add a system message to help the agent understand it's stuck
            const warningMessage = `⚠️ SYSTEM: You have called the '${tool}' tool ${similarCalls.length} times with identical parameters. ` +
                                 `The tool is working correctly and returning results. ` +
                                 `Please process the tool output and continue with your task, or try a different approach. ` +
                                 `Do not call this tool again with the same parameters.`;
            
            messages.push(new Message("system", warningMessage));
            
            // Don't clear history - keep tracking to detect persistent loops
            // this.recentToolCalls = [];
            
            return warningMessage;
        }
        
        return null;
    }
}