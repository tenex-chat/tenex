import { deserializeToolResult, isSerializedToolResult } from "@/llm/ToolResult";
import type { ExecutionLogger } from "@/logging/ExecutionLogger";
import type { ErrorIntent, EventContext } from "@/nostr/AgentEventEncoder";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import type { StreamHandle } from "@/nostr/AgentStreamer";
import type { ToolExecutionResult } from "@/tools/executor";
import type { TracingLogger } from "@/tracing";
import { formatAnyError, formatToolError } from "@/utils/error-formatter";
import type { StreamStateManager } from "./StreamStateManager";
import { ExecutionConfig } from "./constants";
import { isComplete } from "./control-flow-types";
import type { ExecutionContext } from "./types";

/**
 * Handles tool-related events in the LLM stream.
 * Responsible for processing tool_start and tool_complete events,
 * managing tool descriptions, and error handling.
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
    _streamHandle: StreamHandle | undefined,
    toolName: string,
    toolArgs: Record<string, unknown>,
    _tracingLogger: TracingLogger,
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
    _streamHandle: StreamHandle | undefined,
    tracingLogger: TracingLogger,
    context: ExecutionContext
  ): Promise<boolean> {
    // Parse the tool result first to get metadata
    const toolResult = this.parseToolResult(event);

    // Check if this tool never sent a tool_start event
    await this.handleMissingToolStart(event.tool, toolResult, tracingLogger, context);

    // Add result to state
    this.stateManager.addToolResult(toolResult);

    // Log tool execution complete
    this.logToolComplete(toolResult, event.tool, context);

    // Publish error if tool failed
    await this.publishToolError(toolResult, event.tool, tracingLogger, context);

    // Process the tool result (update state with continue/termination)
    this.processToolResult(toolResult, tracingLogger, context);

    // Note: StreamHandle handles buffering internally
    // Typing indicator is managed by ReasonActLoop, not needed here

    // Check if this is a terminal tool
    return this.isTerminalResult(toolResult);
  }

  /**
   * Check if tool never sent a start event and handle it
   */
  private async handleMissingToolStart(
    toolName: string,
    _toolResult: ToolExecutionResult,
    tracingLogger: TracingLogger,
    _context: ExecutionContext
  ): Promise<void> {
    const toolCallPattern = `${toolName}_`;
    const hasStarted = this.stateManager.hasToolStarted(toolCallPattern);

    if (!hasStarted) {
      tracingLogger.debug("Tool completed without corresponding tool_start event", {
        tool: toolName,
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
        error: toolResult.error ? formatToolError(toolResult.error) : undefined,
      }
    );
  }

  /**
   * Publish tool error if execution failed
   */
  private async publishToolError(
    toolResult: ToolExecutionResult,
    toolName: string,
    tracingLogger: TracingLogger,
    context: ExecutionContext
  ): Promise<void> {
    if (!toolResult.success && toolResult.error) {
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

        // Use AgentPublisher.error() instead of legacy approach
        const agentPublisher = new AgentPublisher(context.agent);
        const errorIntent: ErrorIntent = {
          type: "error",
          message: `Tool "${toolName}" failed: ${errorMessage}`,
          errorType: "tool_execution",
        };

        const eventContext: EventContext = {
          triggeringEvent: context.triggeringEvent,
          conversationEvent: context.triggeringEvent, // Use triggering event as conversation context
        };

        await agentPublisher.error(errorIntent, eventContext);

        tracingLogger.info("Tool error published", {
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
    }
  }

  /**
   * Check if tool result is terminal (complete or delegate)
   */
  private isTerminalResult(result: ToolExecutionResult): boolean {
    if (!result.success || !result.output) {
      return false;
    }

    const output = result.output as Record<string, unknown>;
    // Check for terminal intent types (new format)
    return output.type === "completion" || output.type === "delegation";
  }

  /**
   * Check if a tool is terminal by name (before execution)
   * This allows us to skip subsequent tools if a terminal tool is queued
   */
  isTerminalTool(toolName: string): boolean {
    const terminalTools = ["complete", "delegate", "delegate_phase"];
    return terminalTools.includes(toolName.toLowerCase());
  }
}
