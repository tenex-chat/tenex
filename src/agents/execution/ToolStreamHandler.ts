import type { NostrPublisher, StreamPublisher } from "@/nostr/NostrPublisher";
import type { TracingLogger } from "@/tracing";
import type { ExecutionContext } from "./types";
import type { ExecutionLogger } from "@/logging/ExecutionLogger";
import type { ToolExecutionResult } from "@/tools/executor";
import { StreamStateManager } from "./StreamStateManager";
import { ExecutionConfig } from "./constants";
import { formatAnyError, formatToolError } from "@/utils/error-formatter";
import { deserializeToolResult, isSerializedToolResult } from "@/llm/ToolResult";
import { isContinueFlow, isComplete, isEndConversation } from "./control-flow-types";

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

        // Flush stream for non-continue tools
        if (toolName !== "continue") {
            await streamPublisher?.flush();
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
     * @returns true if this was a terminal tool (continue, complete, end_conversation)
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
        publisher?.publishTypingIndicator("stop");

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
            const wasSet = this.stateManager.setContinueFlow(output);
            if (!wasSet) {
                tracingLogger.info(
                    "⚠️ Multiple continue calls detected - ignoring additional calls",
                    {
                        existingAgents: this.stateManager.getContinueFlow()?.routing.agents,
                        newAgents: output.routing.agents,
                    }
                );
                return;
            }
            
            // Log routing decision
            if (this.executionLogger) {
                this.executionLogger.routingDecision(
                    context.agent.name,
                    [...output.routing.agents],
                    output.routing.reason,
                    {
                        targetPhase: output.routing.phase,
                        confidence: 0.85
                    }
                );
            }
        }

        // Check if it's a termination
        if (isComplete(output)) {
            this.stateManager.setTermination(output);
            
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
            this.stateManager.setTermination(output);
            
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

    /**
     * Check if tool result is terminal (continue, complete, or end_conversation)
     */
    private isTerminalResult(result: ToolExecutionResult): boolean {
        if (!result.success || !result.output) {
            return false;
        }

        const output = result.output as Record<string, unknown>;
        return (
            output.type === "continue" ||
            output.type === "complete" ||
            output.type === "end_conversation"
        );
    }

    /**
     * Get human-readable description for a tool
     */
    private getToolDescription(toolName: string, args: Record<string, unknown>): string {
        const descriptions = this.getToolDescriptions();
        const descFn = descriptions[toolName.toLowerCase()] || descriptions.default;
        return descFn ? descFn(args) : `🛠️ Using ${toolName}`;
    }

    /**
     * Tool description generators
     */
    private getToolDescriptions(): Record<string, (args: Record<string, unknown>) => string> {
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