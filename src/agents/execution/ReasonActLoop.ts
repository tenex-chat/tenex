import { formatAnyError } from "@/utils/error-formatter";
import type { LLMService, Tool } from "@/llm/types";
import type { StreamEvent } from "@/llm/types";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import { StreamPublisher } from "@/nostr/NostrPublisher";
import { buildLLMMetadata } from "@/prompts/utils/llmMetadata";
import type { TracingContext, TracingLogger } from "@/tracing";
import { createTracingLogger, createTracingContext } from "@/tracing";
import { Message } from "multi-llm-ts";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { ExecutionBackend } from "./ExecutionBackend";
import type { ExecutionContext } from "./types";
import { createExecutionLogger, type ExecutionLogger } from "@/logging/ExecutionLogger";
import { StreamStateManager } from "./StreamStateManager";
import { ToolStreamHandler } from "./ToolStreamHandler";
import { TerminationHandler } from "./TerminationHandler";
import { ExecutionConfig } from "./constants";

/**
 * Simplified ReasonActLoop implementation using extracted handlers.
 * Orchestrates the main LLM streaming loop without complex nested logic.
 */
export class ReasonActLoop implements ExecutionBackend {
    private executionLogger?: ExecutionLogger;
    private streamingBuffer: Map<string, string> = new Map();
    private lastLoggedChunk: Map<string, string> = new Map();

    constructor(
        private llmService: LLMService,
        private conversationManager: ConversationManager
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

        try {
            let currentMessages = messages;
            let attempt = 0;

            // Main termination loop
            while (attempt < ExecutionConfig.MAX_TERMINATION_ATTEMPTS) {
                attempt++;

                // Reset state for retry (but keep stream publisher)
                if (attempt > 1) {
                    stateManager.resetForRetry();
                }

                // Create and process stream
                const stream = this.createLLMStream(context, currentMessages, tools, publisher);
                const streamPublisher = attempt === 1 
                    ? this.createStreamPublisher(publisher) 
                    : stateManager.getStreamPublisher();
                
                if (streamPublisher) {
                    stateManager.setStreamPublisher(streamPublisher);
                }

                // Process stream events
                yield* this.processStream(
                    stream,
                    stateManager,
                    toolHandler,
                    streamPublisher,
                    publisher,
                    tracingLogger,
                    context
                );

                // Finalize stream
                await this.finalizeStream(
                    streamPublisher,
                    stateManager,
                    context,
                    currentMessages,
                    tracingLogger
                );

                // Check if should retry for termination
                if (!terminationHandler.shouldRetryForTermination(context, attempt, tracingLogger)) {
                    break;
                }

                // Prepare for retry with reminder
                currentMessages = terminationHandler.prepareRetryMessages(
                    currentMessages,
                    context,
                    tracingLogger
                );
            }

            yield this.createFinalEvent(stateManager);

        } catch (error) {
            yield* this.handleError(error, publisher, stateManager, tracingLogger, context);
            throw error;
        }
    }

    private async *processStream(
        stream: AsyncIterable<StreamEvent>,
        stateManager: StreamStateManager,
        toolHandler: ToolStreamHandler,
        streamPublisher: StreamPublisher | undefined,
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext
    ): AsyncGenerator<StreamEvent> {
        // Initialize streaming buffer for this agent
        const agentKey = `${context.agent.name}`;
        this.streamingBuffer.set(agentKey, "");
        
        for await (const event of stream) {
            yield event;

            switch (event.type) {
                case "content":
                    this.handleContentEvent(event, stateManager, streamPublisher, context);
                    this.updateStreamingLog(agentKey, event.content);
                    break;

                case "tool_start":
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
                    const isTerminal = await toolHandler.handleToolCompleteEvent(
                        event,
                        streamPublisher,
                        publisher,
                        tracingLogger,
                        context
                    );

                    if (isTerminal) {
                        yield this.createFinalEvent(stateManager);
                        return;
                    }
                    break;
                }

                case "done":
                    if (event.response) {
                        stateManager.setFinalResponse(event.response);
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
        messages: Message[],
        _tracingLogger: TracingLogger
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
            
            // agentThinking removed - not in new event system
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
}