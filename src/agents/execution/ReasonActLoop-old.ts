import type { CompletionResponse, LLMService, Tool } from "@/llm/types";
import type { StreamEvent } from "@/llm/types";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import { StreamPublisher } from "@/nostr/NostrPublisher";
import { buildLLMMetadata } from "@/prompts/utils/llmMetadata";
import type { ToolExecutionResult } from "@/tools/types";
import type { TracingContext, TracingLogger } from "@/tracing";
import { createTracingLogger, createTracingContext } from "@/tracing";
import { Message } from "multi-llm-ts";
import { deserializeToolResult, isSerializedToolResult } from "@/llm/ToolResult";
import { getProjectContext } from "@/services/ProjectContext";
import type { ExecutionBackend } from "./ExecutionBackend";
import type { ExecutionContext } from "./types";
import { logger } from "@/utils/logger";
import { createExecutionLogger, type ExecutionLogger } from "@/logging/ExecutionLogger";
import { StreamStateManager } from "./StreamStateManager";
import { isContinueFlow, isComplete, isEndConversation } from "./control-flow-types";
import { formatToolError } from "@/utils/error-formatter";
import { ExecutionConfig } from "./constants";


export class ReasonActLoop implements ExecutionBackend {
    private executionLogger?: ExecutionLogger;

    constructor(
        private llmService: LLMService,
        private conversationManager: import(
            "@/conversations/ConversationManager"
        ).ConversationManager
    ) {}

    /**
     * ExecutionBackend interface implementation
     */
    async execute(
        messages: Array<import("multi-llm-ts").Message>,
        tools: Tool[],
        context: ExecutionContext,
        publisher: NostrPublisher
    ): Promise<void> {
        // Create tracing context
        const tracingContext = createTracingContext(context.conversationId);
        
        // Create execution logger for structured event logging
        this.executionLogger = createExecutionLogger(tracingContext, "agent");

        // Execute the streaming loop and collect results
        const generator = this.executeStreamingInternal(
            context,
            messages,
            tracingContext,
            publisher,
            tools
        );

        // Drain the generator to make it execute
        let iterResult: IteratorResult<StreamEvent, void>;
        do {
            iterResult = await generator.next();
        } while (!iterResult.done);

        // Execution is complete - all state updates have been handled by the publisher
    }

    async *executeStreamingInternal(
        context: ExecutionContext,
        messages: Message[],
        tracingContext: TracingContext,
        publisher?: NostrPublisher,
        tools?: Tool[]
    ): AsyncGenerator<StreamEvent, void, unknown> {
        const tracingLogger = createTracingLogger(tracingContext, "agent");
        const stateManager = new StreamStateManager();

        this.logStreamingStart(tracingLogger, context, tools, stateManager);

        try {
            // Check if this agent requires termination enforcement
            const isChat = context.phase.toLowerCase() === "chat";
            const isBrainstormPhase = context.phase.toLowerCase() === "brainstorm";
            const requiresTerminationEnforcement = !isChat && !isBrainstormPhase;

            tracingLogger.info("🚀 Starting executeStreaming with termination enforcement check", {
                agent: context.agent.name,
                isOrchestrator: context.agent.isOrchestrator,
                phase: context.phase,
                requiresTerminationEnforcement,
                reason: `phase is ${context.phase}`,
            });

            let currentMessages = messages;
            let attempt = 0;

            // Allow up to MAX_TERMINATION_ATTEMPTS attempts for proper termination
            while (attempt < ExecutionConfig.MAX_TERMINATION_ATTEMPTS) {
                attempt++;

                tracingLogger.info(
                    `🔄 Termination attempt ${attempt}/${ExecutionConfig.MAX_TERMINATION_ATTEMPTS}`,
                    {
                        agent: context.agent.name,
                        phase: context.phase,
                        requiresTerminationEnforcement,
                        messageCount: currentMessages.length,
                    }
                );

                // Create stream for this attempt
                const stream = this.createLLMStream(context, currentMessages, tools, publisher);
                
                const streamPublisher =
                    attempt === 1
                        ? this.setupStreamPublisher(publisher, tracingLogger, context)
                        : stateManager.getStreamPublisher(); // Reuse existing stream publisher for reminder

                // Reset state for new attempt (but keep streamPublisher)
                if (attempt > 1) {
                    tracingLogger.info("🔄 Resetting state for reminder attempt", {
                        previousContent: stateManager.getFullContent().substring(0, 100) + "...",
                        hadTermination: !!stateManager.getTermination(),
                        hadContinueFlow: !!stateManager.getContinueFlow(),
                    });
                    stateManager.resetForRetry();
                }

                // Process the stream
                yield* this.processStreamEvents(
                    stream,
                    stateManager,
                    streamPublisher,
                    publisher,
                    tracingLogger,
                    context
                );

                // Finalize the stream
                await this.finalizeStream(
                    streamPublisher,
                    stateManager,
                    context,
                    currentMessages,
                    tracingLogger,
                    publisher
                );

                // Check if termination is correct
                const hasTerminated = stateManager.hasTerminated();

                // If terminated properly, we're done
                if (hasTerminated || !requiresTerminationEnforcement) {
                    break;
                }

                // If this is the last attempt, auto-complete
                if (attempt === ExecutionConfig.MAX_TERMINATION_ATTEMPTS) {
                    tracingLogger.info("⚠️ Max attempts reached, auto-completing", {
                        agent: context.agent.name,
                        phase: context.phase,
                    });
                    this.autoCompleteTermination(stateManager, context, tracingLogger);

                    // Publish the auto-generated termination event
                    const termination = stateManager.getTermination();
                    if (publisher && termination) {
                        tracingLogger.info("Publishing auto-generated termination event", {
                            terminationType: termination.type,
                            agent: context.agent.name,
                        });

                        if (termination.type === "complete") {
                            await publisher.publishResponse({
                                content: termination.completion.response,
                                destinationPubkeys: [termination.completion.nextAgent],
                                completeMetadata: termination,
                            });
                        } else if (termination.type === "end_conversation") {
                            await publisher.publishResponse({
                                content: termination.result.response,
                                completeMetadata: termination,
                            });
                        }
                    }

                    break;
                }

                // Otherwise, prepare reminder for next attempt
                tracingLogger.info(
                    `📢 ${context.agent.isOrchestrator ? "Orchestrator" : "Non-orchestrator"} agent did not call terminal tool, preparing reminder`,
                    {
                        agent: context.agent.name,
                        phase: context.phase,
                        attempt,
                        currentContentPreview: stateManager.getFullContent().substring(0, 100) + "...",
                    }
                );

                const reminderMessage = this.getReminderMessage(context);
                tracingLogger.info("📝 Reminder message prepared", {
                    messagePreview: reminderMessage.substring(0, 100) + "...",
                    previousMessageCount: currentMessages.length,
                });

                currentMessages = [
                    ...currentMessages,
                    new Message("assistant", stateManager.getFullContent()),
                    new Message("user", reminderMessage),
                ];
            }

            tracingLogger.info("🏁 Creating final event", {
                hasTermination: !!stateManager.getTermination(),
                hasContinueFlow: !!stateManager.getContinueFlow(),
                terminationType: stateManager.getTermination()?.type,
                continueAgents: stateManager.getContinueFlow()?.routing?.agents,
                contentLength: stateManager.getFullContent().length,
                agent: context.agent.name,
                phase: context.phase,
            });

            yield this.createFinalEvent(stateManager);
        } catch (error) {
            yield* this.handleStreamingError(
                error,
                publisher,
                stateManager.getStreamPublisher(),
                tracingLogger,
                context
            );
            throw error;
        }

        // Execution is complete - all state updates have been handled by the publisher
    }


    private logStreamingStart(
        tracingLogger: TracingLogger,
        context: ExecutionContext,
        tools?: Tool[],
        stateManager?: StreamStateManager
    ): void {
        tracingLogger.info("🔄 Starting ReasonActLoop", {
            agent: context.agent.name,
            phase: context.phase,
            tools: tools?.map((t) => t.name).join(", "),
        });
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

    private setupStreamPublisher(
        publisher: NostrPublisher | undefined,
        _tracingLogger: TracingLogger,
        _context: ExecutionContext
    ): StreamPublisher | undefined {
        if (!publisher) return undefined;

        const streamPublisher = new StreamPublisher(publisher);
        return streamPublisher;
    }

    private async *processStreamEvents(
        stream: AsyncIterable<StreamEvent>,
        stateManager: StreamStateManager,
        streamPublisher: StreamPublisher | undefined,
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext
    ): AsyncGenerator<StreamEvent> {
        if (streamPublisher) {
            stateManager.setStreamPublisher(streamPublisher);
        }

        for await (const event of stream) {
            yield event;

            switch (event.type) {
                case "content":
                    this.handleContentEvent(event, stateManager, streamPublisher, context);
                    break;

                case "tool_start":
                    await this.handleToolStartEvent(
                        streamPublisher,
                        publisher,
                        event.tool,
                        event.args,
                        stateManager,
                        tracingLogger,
                        context
                    );
                    break;

                case "tool_complete": {
                    const isTerminal = await this.handleToolCompleteEvent(
                        event,
                        stateManager,
                        streamPublisher,
                        publisher,
                        tracingLogger,
                        context
                    );

                    // If this was a terminal tool, we should stop processing
                    if (isTerminal) {
                        tracingLogger.info(
                            "Terminal tool detected - stopping stream processing",
                            {
                                tool: event.tool,
                                type: event.tool === "continue" ? "routing" : "completion",
                                agents: stateManager.getContinueFlow()?.routing?.agents,
                            }
                        );

                        // All terminal tools should stop processing here
                        // The continue() tool will execute agents in finalizeStream
                        yield this.createFinalEvent(stateManager);
                        return;
                    }
                    break;
                }

                case "done":
                    this.handleDoneEvent(event, stateManager, tracingLogger);
                    break;

                case "error":
                    this.handleErrorEvent(event, stateManager, streamPublisher, tracingLogger, context);
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
        this.extractAndLogReasoning(stateManager.getFullContent(), context);
        
        // Orchestrator should remain silent - don't add content to stream
        if (!context?.agent.isOrchestrator) {
            streamPublisher?.addContent(event.content);
        } else {
            logger.info("[StreamPublisher] Skipping content for orchestrator", {
                content: event.content,
                agent: context?.agent.name,
            });
        }
    }
    
    private extractAndLogReasoning(content: string, context?: ExecutionContext): void {
        if (!this.executionLogger || !context) return;
        
        // Extract thinking content
        const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/g);
        if (!thinkingMatch) return;
        
        // Process each thinking block (in case there are multiple)
        thinkingMatch.forEach(block => {
            const contentMatch = block.match(/<thinking>([\s\S]*?)<\/thinking>/);
            if (!contentMatch || !contentMatch[1]) return;
            
            const thinkingContent = contentMatch[1].trim();
            
            // Parse structured reasoning
            const reasoningData = this.parseReasoningContent(thinkingContent);
            
            // Log agent thinking
            this.executionLogger?.agentThinking(
                context.agent.name,
                reasoningData.reasoning || thinkingContent,
                {
                    userMessage: reasoningData.currentSituation,
                    considerations: reasoningData.options,
                    leaningToward: reasoningData.decision,
                    confidence: reasoningData.confidence
                }
            );
        });
    }
    
    private parseReasoningContent(content: string): {
        currentSituation?: string;
        options?: string[];
        decision?: string;
        confidence?: number;
        reasoning?: string;
    } {
        const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
        const result: Record<string, unknown> = {};
        
        lines.forEach(line => {
            if (line.startsWith('- Current situation:')) {
                result.currentSituation = line.substring('- Current situation:'.length).trim();
            } else if (line.startsWith('- Options considered:')) {
                result.options = line.substring('- Options considered:'.length).trim().split(',').map(o => o.trim());
            } else if (line.startsWith('- Decision:')) {
                result.decision = line.substring('- Decision:'.length).trim();
            } else if (line.startsWith('- Confidence:')) {
                const confStr = line.substring('- Confidence:'.length).trim();
                result.confidence = parseFloat(confStr);
            } else if (line.startsWith('- Reasoning:')) {
                result.reasoning = line.substring('- Reasoning:'.length).trim();
            }
        });
        
        // If no structured reasoning found, use the whole content
        if (Object.keys(result).length === 0) {
            result.reasoning = content;
        }
        
        return result;
    }

    private async handleToolStartEvent(
        streamPublisher: StreamPublisher | undefined,
        publisher: NostrPublisher | undefined,
        toolName: string,
        toolArgs: Record<string, unknown>,
        stateManager: StreamStateManager,
        tracingLogger: TracingLogger,
        context?: ExecutionContext
    ): Promise<void> {
        // Create a unique ID for this tool call (based on tool name and current timestamp)
        const toolCallId = `${toolName}_${Date.now()}`;
        stateManager.markToolStarted(toolCallId);
        
        // Log tool execution start with ExecutionLogger
        if (this.executionLogger && context) {
            this.executionLogger.toolStart(context.agent.name, toolName, toolArgs);
        }
        if (toolName !== "continue") {
            await streamPublisher?.flush();
        }

        // Publish typing indicator with tool information
        if (publisher) {
            // Get the appropriate description function
            const toolDescriptions = this.getToolDescriptions(toolName);
            const descFn = toolDescriptions[toolName.toLowerCase()] || toolDescriptions.default;
            const message = descFn ? descFn(toolArgs) : `🛠️ Using ${toolName}`;

            tracingLogger.debug("Publishing typing indicator with tool info", {
                tool: toolName,
                hasArgs: Object.keys(toolArgs).length > 0,
                message,
            });

            await publisher.publishTypingIndicator("start", message);
        }
    }

    private getToolDescriptions(toolName: string): Record<string, (args: Record<string, unknown>) => string> {
        return {
                // File operations
                read: (args) => `📖 Reading ${args.file_path || args.path || "file"}`,
                write: (args) => `✏️ Writing to ${args.file_path || args.path || "file"}`,
                edit: (args) => `✏️ Editing ${args.file_path || args.path || "file"}`,
                multiedit: (args) => `✏️ Making multiple edits to ${args.file_path || args.path || "file"}`,
                ls: (args) => `📁 Listing files in ${args.path || "directory"}`,
                glob: (args) => `🔍 Searching for files matching "${args.pattern || "pattern"}"`,
                grep: (args) => `🔍 Searching for "${args.pattern || "pattern"}" in files`,
                
                // Git operations
                bash: (args) => {
                    const cmd = args.command as string || "";
                    if (cmd.startsWith("git")) {
                        return `🔧 Running git command: ${cmd.substring(0, 50)}${cmd.length > 50 ? "..." : ""}`;
                    }
                    return `🖥️ Running command: ${cmd.substring(0, 50)}${cmd.length > 50 ? "..." : ""}`;
                },
                
                // Web operations
                webfetch: (args) => `🌐 Fetching content from ${args.url || "web"}`,
                websearch: (args) => `🔎 Searching the web for "${args.query || "query"}"`,
                
                // Documentation
                notebookread: (args) => `📓 Reading notebook ${args.notebook_path || "file"}`,
                notebookedit: (args) => `📓 Editing notebook ${args.notebook_path || "file"}`,
                
                // Analysis
                task: (args) => `🤖 Delegating task: ${args.description || "complex task"}`,
                analyze: (args) => `🔬 Analyzing code with prompt: "${(args.prompt as string || "").substring(0, 50)}..."`,
                
                // Control flow
                continue: (args) => {
                    const routing = args.routing as { agents?: unknown[]; reason?: string };
                    if (routing?.agents && Array.isArray(routing.agents)) {
                        return `🔄 Routing to agents for ${routing.reason || "next phase"}`;
                    }
                    return `🔄 Continuing workflow`;
                },
                complete: () => `✅ Completing task and returning control`,
                endconversation: () => `🏁 Ending conversation`,
                
                // MCP tools
                default: (_args) => {
                    // For MCP tools, try to create a descriptive message
                    if (toolName.startsWith("mcp__")) {
                        const parts = toolName.split("__");
                        const provider = parts[1] || "mcp";
                        const action = parts[2] || "action";
                        return `🔌 Using ${provider} to ${action.replace(/_/g, " ")}`;
                    }
                    return `🛠️ Using ${toolName}`;
                }
            };
    }

    private async handleToolCompleteEvent(
        event: { tool: string; result: unknown },
        stateManager: StreamStateManager,
        streamPublisher: StreamPublisher | undefined,
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext
    ): Promise<boolean> {
        tracingLogger.info("🛠️ Tool complete event received", {
            tool: event.tool,
            agent: context.agent.name,
            isOrchestrator: context.agent.isOrchestrator,
            phase: context.phase,
        });

        // Check if this tool never sent a tool_start event
        const toolCallPattern = `${event.tool}_`;
        const hasStarted = stateManager.hasToolStarted(toolCallPattern);
        
        if (!hasStarted && publisher) {
            tracingLogger.info("Tool skipped start event, publishing typing indicator", {
                tool: event.tool,
                agent: context.agent.name,
            });
            
            // Get the tool description function
            const toolDescriptions = this.getToolDescriptions(event.tool);
            const descFn = toolDescriptions[event.tool.toLowerCase()] || toolDescriptions.default;
            
            // Note: We don't have args for tools that skip start, so pass empty object
            const message = descFn ? descFn({}) : `🛠️ Using ${event.tool}`;
            await publisher.publishTypingIndicator("start", message);
            
            // Brief delay to ensure the typing indicator is visible
            await new Promise(resolve => setTimeout(resolve, ExecutionConfig.TOOL_INDICATOR_DELAY_MS));
        }

        const toolResult = this.parseToolResult(event);
        stateManager.addToolResult(toolResult);
        
        // Log tool execution complete with ExecutionLogger
        if (this.executionLogger) {
            // We don't have the exact start time, so use a reasonable estimate
            const duration = ExecutionConfig.DEFAULT_TOOL_DURATION_MS; // Default 1 second, could be improved with tracking
            this.executionLogger.toolComplete(
                context.agent.name,
                event.tool,
                toolResult.success ? "success" : "error",
                duration,
                {
                    result: toolResult.success && toolResult.output ? String(toolResult.output) : undefined,
                    error: toolResult.error ? formatToolError(toolResult.error) : undefined
                }
            );
        }

        // Check if tool execution failed and publish error
        if (!toolResult.success && toolResult.error && publisher) {
            try {
                // Format error message based on error type
                let errorMessage: string;
                if (typeof toolResult.error === "string") {
                    errorMessage = toolResult.error;
                } else if (
                    toolResult.error &&
                    typeof toolResult.error === "object" &&
                    "message" in toolResult.error
                ) {
                    errorMessage = (toolResult.error as { message: string }).message;
                } else {
                    errorMessage = JSON.stringify(toolResult.error);
                }

                await publisher.publishError(`Tool "${event.tool}" failed: ${errorMessage}`);
                tracingLogger.info("Published tool error to conversation", {
                    tool: event.tool,
                    error: errorMessage,
                });
            } catch (error) {
                tracingLogger.error("Failed to publish tool error", {
                    tool: event.tool,
                    originalError: toolResult.error,
                    publishError: error instanceof Error ? error.message : String(error),
                });
            }
        }

        this.processToolResult(toolResult, stateManager, tracingLogger, context);

        await streamPublisher?.flush();
        publisher?.publishTypingIndicator("stop");

        // Check if this is a terminal tool
        const isTerminal = this.isTerminalResult(toolResult);

        return isTerminal;
    }

    private parseToolResult(event: { tool: string; result: unknown }): ToolExecutionResult {
        // Check if we have a typed result from ToolPlugin
        if (!event.result || typeof event.result !== "object") {
            throw new Error(`Tool '${event.tool}' returned invalid result format`);
        }

        const result = event.result as Record<string, unknown>;

        // Tool results must include the typed result
        if (!result.__typedResult || !isSerializedToolResult(result.__typedResult)) {
            throw new Error(
                `Tool '${event.tool}' returned invalid result format. Missing or invalid __typedResult.`
            );
        }

        return deserializeToolResult(result.__typedResult);
    }

    private processToolResult(
        toolResult: ToolExecutionResult,
        stateManager: StreamStateManager,
        tracingLogger: TracingLogger,
        context: ExecutionContext
    ): void {
        tracingLogger.info("🔧 Processing tool result", {
            success: toolResult.success,
            hasOutput: !!toolResult.output,
            outputType:
                toolResult.output &&
                typeof toolResult.output === "object" &&
                toolResult.output !== null &&
                "type" in toolResult.output
                    ? String(toolResult.output.type)
                    : "none",
            agent: context.agent.name,
            isOrchestrator: context.agent.isOrchestrator,
        });

        if (!toolResult.success || !toolResult.output) {
            tracingLogger.info("⚠️ Tool result unsuccessful or missing output", {
                success: toolResult.success,
                hasOutput: !!toolResult.output,
            });
            return;
        }

        const output = toolResult.output;

        // Check if it's a continue flow
        if (isContinueFlow(output)) {
            // Only process the first continue
            const wasSet = stateManager.setContinueFlow(output);
            if (!wasSet) {
                tracingLogger.info(
                    "⚠️ Multiple continue calls detected - ignoring additional calls",
                    {
                        existingAgents: stateManager.getContinueFlow()?.routing.agents,
                        newAgents: output.routing.agents,
                    }
                );
                return;
            }
            
            // Log routing decision with ExecutionLogger
            if (this.executionLogger) {
                this.executionLogger.routingDecision(
                    context.agent.name,
                    [...output.routing.agents],
                    output.routing.reason,
                    {
                        targetPhase: output.routing.phase,
                        confidence: 0.85 // Could be extracted from reasoning
                    }
                );
            }

            // Increment continue call count
            if (this.conversationManager && context.conversationId && context.phase) {
                this.conversationManager
                    .incrementContinueCallCount(context.conversationId, context.phase)
                    .catch((error) => {
                        tracingLogger.error("Failed to increment continue call count", {
                            error: error instanceof Error ? error.message : String(error),
                            conversationId: context.conversationId,
                            phase: context.phase,
                        });
                    });
            }
        }

        // Check if it's a termination (complete or end_conversation)
        if (isComplete(output)) {
            stateManager.setTermination(output);
            
            // Log completion decision
            if (this.executionLogger) {
                this.executionLogger.agentDecision(
                    context.agent.name,
                    "completion",
                    "complete_task",
                    output.completion.summary || "Task completed",
                    { confidence: 0.9 }
                );
            }
        } else if (isEndConversation(output)) {
            stateManager.setTermination(output);
            
            // Log end conversation decision
            if (this.executionLogger) {
                this.executionLogger.agentDecision(
                    context.agent.name,
                    "completion",
                    "end_conversation",
                    output.result.summary || "Conversation ended",
                    { confidence: 0.95 }
                );
            }
        }
    }

    private isTerminalResult(result: ToolExecutionResult): boolean {
        if (!result.success || !result.output) {
            return false;
        }

        const output = result.output as Record<string, unknown>;
        // Check if it's a control flow or termination
        return (
            output.type === "continue" ||
            output.type === "complete" ||
            output.type === "end_conversation"
        );
    }

    private handleDoneEvent(
        event: { response?: CompletionResponse },
        stateManager: StreamStateManager,
        _tracingLogger: TracingLogger
    ): void {
        if (event.response) {
            stateManager.setFinalResponse(event.response);
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
        
        // Orchestrator should remain silent - don't add error content to stream
        if (!context?.agent.isOrchestrator) {
            streamPublisher?.addContent(`\n\nError: ${event.error}`);
        }
    }

    private async finalizeStream(
        streamPublisher: StreamPublisher | undefined,
        stateManager: StreamStateManager,
        context: ExecutionContext,
        messages: Message[],
        _tracingLogger: TracingLogger,
        _publisher?: NostrPublisher
    ): Promise<void> {
        if (!streamPublisher || streamPublisher.isFinalized()) return;

        const finalResponse = stateManager.getFinalResponse();
        const llmMetadata = finalResponse
            ? await buildLLMMetadata(finalResponse, messages)
            : undefined;

        // Convert flow/termination to metadata for finalization
        const metadata: Record<string, unknown> = {};
        const continueFlow = stateManager.getContinueFlow();
        const termination = stateManager.getTermination();
        
        if (continueFlow) {
            metadata.continueMetadata = continueFlow;
        } else if (termination) {
            if (termination.type === "complete") {
                metadata.completeMetadata = termination;
            } else if (termination.type === "end_conversation") {
                metadata.completeMetadata = termination;
            }
        }

        // Orchestrator should remain silent - only finalize if there's metadata (terminal tools)
        // Skip finalization if orchestrator only has content with no terminal tool
        if (!context.agent.isOrchestrator || continueFlow || termination) {
            await streamPublisher.finalize({
                llmMetadata,
                ...metadata,
            });
        }
    }

    private getReminderMessage(context: ExecutionContext): string {
        if (context.agent.isOrchestrator) {
            return `I see you've finished processing, but you haven't used the 'continue' tool yet. As the orchestrator, you MUST use the 'continue' tool to route to appropriate agents for the next task. Remember: you are a silent router - use continue() to route, never speak to users directly.`;
        } else {
            return "I see you've finished responding, but you haven't used the 'complete' tool yet. As a non-orchestrator agent, you MUST use the 'complete' tool to signal that your work is done and report back to the orchestrator. Please use the 'complete' tool now with a summary of what you accomplished.";
        }
    }


    private autoCompleteTermination(
        stateManager: StreamStateManager,
        context: ExecutionContext,
        tracingLogger: TracingLogger
    ): void {
        tracingLogger.error(
            `${context.agent.isOrchestrator ? "Orchestrator" : "Agent"} failed to call terminal tool even after reminder - auto-completing`,
            {
                agent: context.agent.name,
                phase: context.phase,
                conversationId: context.conversationId,
                isOrchestrator: context.agent.isOrchestrator,
            }
        );

        const autoCompleteContent = stateManager.getFullContent() || "Task completed";

        if (context.agent.isOrchestrator) {
            // For orchestrator, we need to auto-route somewhere
            // This is a fallback - orchestrator should always use continue()
            tracingLogger.error("Orchestrator failed to route - this should not happen", {
                agent: context.agent.name,
                phase: context.phase,
            });
            // We can't auto-complete for orchestrator since it needs to route
            throw new Error("Orchestrator must use continue() tool to route messages");
        } else {
            // For non-orchestrator, complete back to orchestrator
            const projectContext = getProjectContext();
            const orchestratorAgent = projectContext.getProjectAgent();

            stateManager.setTermination({
                type: "complete",
                completion: {
                    response: autoCompleteContent,
                    summary:
                        "Agent completed its turn but failed to call the complete tool after a reminder. [Auto-completed by system]",
                    nextAgent: orchestratorAgent.pubkey,
                },
            });
        }
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

        // Add additional properties that AgentExecutor expects
        return Object.assign(baseEvent, {
            continueFlow: stateManager.getContinueFlow(),
            termination: stateManager.getTermination(),
        }) as StreamEvent;
    }

    private async *handleStreamingError(
        error: unknown,
        publisher: NostrPublisher | undefined,
        streamPublisher: StreamPublisher | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext
    ): AsyncGenerator<StreamEvent> {
        tracingLogger.error("Streaming error", {
            error: error instanceof Error ? error.message : String(error),
            agent: context.agent.name,
        });

        if (streamPublisher && !streamPublisher.isFinalized()) {
            try {
                await streamPublisher.finalize({});
            } catch (finalizeError) {
                tracingLogger.error("Failed to finalize stream on error", {
                    error:
                        finalizeError instanceof Error
                            ? finalizeError.message
                            : String(finalizeError),
                });
            }
        }

        publisher?.publishTypingIndicator("stop");

        yield {
            type: "error",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
