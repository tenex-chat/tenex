import { deserializeToolResult, isSerializedToolResult } from "@/llm/ToolResult";
import type { ErrorIntent, EventContext } from "@/nostr/AgentEventEncoder";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { ToolExecutionResult } from "@/tools/executor";
import { formatAnyError } from "@/utils/error-formatter";
import { logError, logDebug } from "@/utils/logger";
import type { StreamStateManager } from "./StreamStateManager";
import type { ExecutionContext } from "./types";

/**
 * Handles tool-related events in the LLM stream.
 * Responsible for processing tool_start and tool_complete events,
 * managing tool descriptions, and error handling.
 */
export class ToolStreamHandler {
  constructor(
    private stateManager: StreamStateManager,
    private agentPublisher: AgentPublisher
  ) {}

  /**
   * Handle a tool_complete event
   */
  async handleToolCompleteEvent(
    event: { tool: string; result: unknown },
    context: ExecutionContext
  ): Promise<ToolExecutionResult> {
    // Parse the tool result first to get metadata
    const toolResult = this.parseToolResult(event);

    // Publish error if tool failed
    await this.publishToolError(toolResult, event.tool, context);
    
    return toolResult;
  }

  /**
   * Check if tool never sent a start event and handle it
   */

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
   * Publish tool error if execution failed
   */
  private async publishToolError(
    toolResult: ToolExecutionResult,
    toolName: string,
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

        // Use the injected AgentPublisher instance
        const errorIntent: ErrorIntent = {
          type: "error",
          message: `Tool "${toolName}" failed: ${errorMessage}`,
          errorType: "tool_execution",
        };

        const conversation = context.conversationCoordinator.getConversation(context.conversationId);
        const eventContext: EventContext = {
          triggeringEvent: context.triggeringEvent,
          rootEvent: conversation?.history?.[0] ?? context.triggeringEvent, // Use triggering event as fallback
          conversationId: context.conversationId,
        };

        await this.agentPublisher.error(errorIntent, eventContext);

        logDebug(
          "Tool error published",
          "tools",
          "debug",
          {
            tool: toolName,
            error: errorMessage,
          }
        );
      } catch (error) {
        logError(
          "Failed to publish tool error",
          error,
          "tools"
        );
        logDebug(
          "Tool error details",
          "tools",
          "debug",
          {
            tool: toolName,
            originalError: toolResult.error,
          publishError: formatAnyError(error),
        });
      }
    }
  }

}
