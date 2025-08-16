import type { NostrPublisher } from "@/nostr/NostrPublisher";
import { StreamPublisher } from "@/nostr/NostrPublisher";
import type { TracingLogger } from "@/tracing";
import type { ExecutionContext } from "./types";
import type { ExecutionLogger } from "@/logging/ExecutionLogger";
import type { ToolExecutionResult } from "@/tools/executor";
import { StreamStateManager } from "./StreamStateManager";
import { ExecutionConfig } from "./constants";
import { formatAnyError, formatToolError } from "@/utils/error-formatter";
import { deserializeToolResult, isSerializedToolResult } from "@/llm/ToolResult";
import { isComplete } from "./control-flow-types";
import type { ToolName } from "@/tools/registry";

/**
 * Handles tool-related events in the LLM stream.
 * Responsible for processing tool_start and tool_complete events,
 * managing tool descriptions, publishing typing indicators, and error handling.
 */
export class ToolStreamHandler {
    constructor(
        private stateManager: StreamStateManager,
        private executionLogger?: ExecutionLogger
    ) {}

    /**
     * Handle a tool_start event
     */
    async handleToolStartEvent(
        streamPublisher: StreamPublisher | undefined,
        publisher: NostrPublisher | undefined,
        toolName: string,
        toolArgs: Record<string, unknown>,
        tracingLogger: TracingLogger,
        context?: ExecutionContext
    ): Promise<void> {
        // Create a unique ID for this tool call
        const toolCallId = `${toolName}_${Date.now()}`;
        this.stateManager.markToolStarted(toolCallId);
        
        // Log tool execution start
        if (this.executionLogger && context) {
            this.executionLogger.toolStart(context.agent.name, toolName, toolArgs);
        }

        // Finalize the stream if there's any buffered content
        // This ensures any content generated before tool use is published as a complete reply
        if (streamPublisher && !streamPublisher.isFinalized()) {
            // Check the content accumulated within the streamPublisher itself
            const hasContent = streamPublisher.getAccumulatedContent().trim().length > 0;
            if (hasContent) {
                tracingLogger.debug("Finalizing buffered content before tool execution", {
                    tool: toolName,
                    contentLength: streamPublisher.getAccumulatedContent().length
                });
                await streamPublisher.finalize({});
                
                // Create a new stream publisher for subsequent content
                if (publisher) {
                    const newStreamPublisher = new StreamPublisher(publisher);
                    this.stateManager.setStreamPublisher(newStreamPublisher);
                    tracingLogger.debug("Created new StreamPublisher for post-tool content");
                }
            } else {
                // Just flush if no content
                await streamPublisher.flush();
            }
        }

        // Publish typing indicator with tool information
        if (publisher) {
            const message = this.getToolDescription(toolName, toolArgs);
            
            tracingLogger.debug("Publishing typing indicator with tool info", {
                tool: toolName,
                hasArgs: Object.keys(toolArgs).length > 0,
                message,
            });

            await publisher.publishTypingIndicator("start", message);
        }
    }

    /**
     * Handle a tool_complete event
     * @returns true if this was a terminal tool (continue, complete)
     */
    async handleToolCompleteEvent(
        event: { tool: string; result: unknown },
        streamPublisher: StreamPublisher | undefined,
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext
    ): Promise<boolean> {
        // Parse the tool result first to get metadata
        const toolResult = this.parseToolResult(event);
        
        // Check if this tool never sent a tool_start event
        // Pass the tool result so we can use metadata if available
        await this.handleMissingToolStart(event.tool, toolResult, publisher, tracingLogger, context);

        // Add result to state
        this.stateManager.addToolResult(toolResult);
        
        // Log tool execution complete
        this.logToolComplete(toolResult, event.tool, context);

        // Publish error if tool failed
        await this.publishToolError(toolResult, event.tool, publisher, tracingLogger);

        // Process the tool result (update state with continue/termination)
        this.processToolResult(toolResult, tracingLogger, context);

        // Flush stream and stop typing indicator
        await streamPublisher?.flush();
        await publisher?.publishTypingIndicator("stop");

        // Check if this is a terminal tool
        return this.isTerminalResult(toolResult);
    }

    /**
     * Check if tool never sent a start event and handle it
     */
    private async handleMissingToolStart(
        toolName: string,
        toolResult: ToolExecutionResult,
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger,
        _context: ExecutionContext
    ): Promise<void> {
        const toolCallPattern = `${toolName}_`;
        const hasStarted = this.stateManager.hasToolStarted(toolCallPattern);
        
        if (!hasStarted && publisher) {
            let message: string;
            
            // First try to use metadata from the tool result
            if (toolResult.metadata?.displayMessage) {
                message = toolResult.metadata.displayMessage;
                tracingLogger.debug("Using tool-provided display message", {
                    tool: toolName,
                    message,
                });
            } else if (toolResult.metadata?.executedArgs) {
                // Try to generate a message from executed args
                message = this.getToolDescription(toolName, toolResult.metadata.executedArgs);
                tracingLogger.debug("Generated message from executed args", {
                    tool: toolName,
                    args: toolResult.metadata.executedArgs,
                    message,
                });
            } else {
                // Fall back to generic message
                message = this.getToolDescription(toolName, {});
                tracingLogger.debug("Using generic tool description", {
                    tool: toolName,
                    message,
                });
            }
            
            await publisher.publishTypingIndicator("start", message);
            
            // Brief delay to ensure the typing indicator is visible
            await new Promise(resolve => setTimeout(resolve, ExecutionConfig.TOOL_INDICATOR_DELAY_MS));
        }
    }

    /**
     * Parse tool result from event
     */
    private parseToolResult(event: { tool: string; result: unknown }): ToolExecutionResult {
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

    /**
     * Log tool completion with ExecutionLogger
     */
    private logToolComplete(
        toolResult: ToolExecutionResult,
        toolName: string,
        context: ExecutionContext
    ): void {
        if (!this.executionLogger) return;

        // We don't have the exact start time, so use a reasonable estimate
        const duration = ExecutionConfig.DEFAULT_TOOL_DURATION_MS;
        
        this.executionLogger.toolComplete(
            context.agent.name,
            toolName,
            toolResult.success ? "success" : "error",
            duration,
            {
                result: toolResult.success && toolResult.output ? String(toolResult.output) : undefined,
                error: toolResult.error ? formatToolError(toolResult.error) : undefined
            }
        );
    }

    /**
     * Publish tool error if execution failed
     */
    private async publishToolError(
        toolResult: ToolExecutionResult,
        toolName: string,
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger
    ): Promise<void> {
        if (!toolResult.success && toolResult.error && publisher) {
            try {
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

                await publisher.publishError(`Tool "${toolName}" failed: ${errorMessage}`);
                tracingLogger.info("Published tool error to conversation", {
                    tool: toolName,
                    error: errorMessage,
                });
            } catch (error) {
                tracingLogger.error("Failed to publish tool error", {
                    tool: toolName,
                    originalError: toolResult.error,
                    publishError: formatAnyError(error),
                });
            }
        }
    }

    /**
     * Process tool result and update state
     */
    private processToolResult(
        toolResult: ToolExecutionResult,
        tracingLogger: TracingLogger,
        _context: ExecutionContext
    ): void {
        if (!toolResult.success || !toolResult.output) {
            tracingLogger.info("⚠️ Tool result unsuccessful or missing output", {
                success: toolResult.success,
                hasOutput: !!toolResult.output,
            });
            return;
        }

        const output = toolResult.output;

        // Check if it's a termination
        if (isComplete(output)) {
            this.stateManager.setTermination(output);
            
            // Store the serialized event if present (for deferred publishing)
            if (output.serializedEvent) {
                this.stateManager.setDeferredEvent(output.serializedEvent);
                
                tracingLogger.info("[ToolStreamHandler] Stored serialized event for deferred publishing", {
                    hasSerializedEvent: true,
                    eventKeys: Object.keys(output.serializedEvent),
                    contentLength: output.serializedEvent.content?.length || 0,
                });
            } else {
                tracingLogger.info("[ToolStreamHandler] Complete tool has no serialized event", {
                    hasSerializedEvent: false,
                });
            }
        }
    }

    /**
     * Check if tool result is terminal (complete)
     */
    private isTerminalResult(result: ToolExecutionResult): boolean {
        if (!result.success || !result.output) {
            return false;
        }

        const output = result.output as Record<string, unknown>;
        return output.type === "complete";
    }

    /**
     * Get human-readable description for a tool
     */
    private getToolDescription(toolName: string, args: Record<string, unknown>): string {
        const descriptions = this.getToolDescriptions();
        const normalizedName = toolName.toLowerCase();
        const descFn = descriptions[normalizedName as keyof typeof descriptions] || descriptions.default;
        return descFn ? descFn(args) : `🛠️ Using ${toolName}`;
    }

    /**
     * Tool description generators
     */
    private getToolDescriptions(): Partial<Record<ToolName | 'default', (args: Record<string, unknown>) => string>> {
        return {
            // Core tool operations
            read_path: (args) => `📖 Reading ${args.path || "file"}`,
            write_context_file: (args) => `✏️ Writing context to ${args.filePath || "file"}`,
            shell: (args) => `🖥️ Executing shell command: ${(args.command as string || "").substring(0, 50)}${(args.command as string || "").length > 50 ? "..." : ""}`,
            analyze: (args) => `🔬 Analyzing code with prompt: "${(args.prompt as string || "").substring(0, 50)}..."`,
            generate_inventory: () => `📃 Generating inventory`,
            lesson_learn: (args) => `🎓 Learning lesson: ${args.title || "new lesson"}`,
            lesson_get: (args) => `📖 Getting lesson: ${args.id || "lesson"}`,
            agents_discover: () => `🔍 Discovering available agents`,
            agents_hire: (args) => `🤖 Hiring agent: ${args.agentId || "agent"}`,
            discover_capabilities: () => `🔌 Discovering MCP capabilities`,
            delegate: (args) => `🔄 Delegating task: ${args.description || "task"}`,
            nostr_projects: () => `📡 Managing Nostr projects`,
            
            // Control flow
            complete: () => `✅ Completing task and returning control`,
            
            // MCP tools
            default: (args) => {
                // For MCP tools, try to create a descriptive message
                const toolName = args.toolName as string || "tool";
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
}