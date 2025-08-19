import type { NostrPublisher } from "@/nostr/NostrPublisher";
import type { StreamHandle } from "@/nostr/AgentStreamer";
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
        streamHandle: StreamHandle | undefined,
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
        
        // Note: StreamHandle doesn't have a flush method - it handles buffering internally
        // No action needed here for streaming
    }

    /**
     * Handle a tool_complete event
     * @returns true if this was a terminal tool (continue, complete)
     */
    async handleToolCompleteEvent(
        event: { tool: string; result: unknown },
        streamHandle: StreamHandle | undefined,
        publisher: NostrPublisher | undefined,
        tracingLogger: TracingLogger,
        context: ExecutionContext
    ): Promise<boolean> {
        // Parse the tool result first to get metadata
        const toolResult = this.parseToolResult(event);
        
        // Check if this tool never sent a tool_start event
        await this.handleMissingToolStart(event.tool, toolResult, publisher, tracingLogger, context);

        // Add result to state
        this.stateManager.addToolResult(toolResult);
        
        // Log tool execution complete
        this.logToolComplete(toolResult, event.tool, context);

        // Publish error if tool failed
        await this.publishToolError(toolResult, event.tool, publisher, tracingLogger);

        // Process the tool result (update state with continue/termination)
        this.processToolResult(toolResult, tracingLogger, context);

        // Note: StreamHandle handles buffering internally
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
        
        if (!hasStarted) {
            tracingLogger.debug("Tool completed without corresponding tool_start event", {
                tool: toolName,
                hasPublisher: !!publisher,
            });
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

                // TODO: Need to refactor to use AgentPublisher.error() instead
                // await publisher.publishError(`Tool "${toolName}" failed: ${errorMessage}`);
                tracingLogger.info("Tool error occurred (not published)", {
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

        // Check if it's a termination (complete tool)
        if (isComplete(output)) {
            // Mark as terminated
            this.stateManager.setTermination(output);
            
            tracingLogger.info("[ToolStreamHandler] Complete tool executed", {
                hasTermination: true,
            });
        }
        
        // Note: Both complete and delegate tools now publish events immediately,
        // no deferred processing needed
    }

    /**
     * Check if tool result is terminal (complete or delegate)
     */
    private isTerminalResult(result: ToolExecutionResult): boolean {
        if (!result.success || !result.output) {
            return false;
        }

        const output = result.output as Record<string, unknown>;
        // Check for new deferred event format
        if (output.toolType === 'complete' || output.toolType === 'delegate' || output.toolType === 'delegate_phase') {
            return true;
        }
        
        // Legacy check for backwards compatibility
        return output.type === "complete" || (!!output.taskIds && Array.isArray(output.taskIds));
    }

    /**
     * Check if a tool is terminal by name (before execution)
     * This allows us to skip subsequent tools if a terminal tool is queued
     */
    isTerminalTool(toolName: string): boolean {
        const terminalTools = ['complete', 'delegate', 'delegate_phase'];
        return terminalTools.includes(toolName.toLowerCase());
    }

    /**
     * Check if a tool should skip publishing tool use events
     * Some tools handle their own event publishing or shouldn't show indicators
     */
    private shouldSkipToolUseEvent(toolName: string): boolean {
        const skipTools = [
            'claude_code',  // Handles its own event publishing
            // Add other tools here that shouldn't publish tool use events
        ];
        return skipTools.includes(toolName.toLowerCase());
    }

    /**
     * Get human-readable description for a tool
     */
    private getToolDescription(toolName: string, args: Record<string, unknown>): string {
        // Skip generating description for tools that don't publish events
        if (this.shouldSkipToolUseEvent(toolName)) {
            return '';
        }
        
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