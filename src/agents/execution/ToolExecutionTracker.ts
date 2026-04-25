/**
 * ToolExecutionTracker - Manages tool execution lifecycle during LLM streaming.
 *
 * Tracks executions from start to completion, coordinating between async events and
 * ensuring proper correlation between Nostr events, tool results, and persistence.
 *
 * Responsibilities:
 * - Event Correlation: Matches tool results with their initial execution events
 * - Persistence: Stores tool messages for conversation history
 *
 * Note: tool_use Nostr publishing is handled entirely by ToolUsePublishingWrapper,
 * which runs inside the AI SDK's awaited execute() call. This tracker is not in
 * the publishing critical path.
 */

import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { shortenEventId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import { extractErrorDetails } from "./ToolResultUtils";
import type { FullResultStash } from "./ToolOutputTruncation";

/**
 * Represents a tracked tool execution
 */
interface TrackedExecution {
    /** Unique identifier for this tool call */
    toolCallId: string;
    /** Name of the tool being executed */
    toolName: string;
    /** Conversation ID used to scope persisted tool results */
    conversationId?: string;
    /** Nostr event ID published by ToolUsePublishingWrapper (set via setToolEventId) */
    toolEventId: string;
    /** Input arguments passed to the tool */
    input: unknown;
    /** Output from the tool (available after completion) */
    output?: unknown;
    /** Whether the tool execution resulted in an error */
    error?: boolean;
    /** Whether the tool has completed execution */
    completed: boolean;
}

/**
 * Options for tracking a new tool execution
 */
export interface TrackExecutionOptions {
    /** Unique identifier for this tool call */
    toolCallId: string;
    /** Name of the tool being executed */
    toolName: string;
    /** Arguments passed to the tool */
    args: unknown;
    /** Conversation ID that scopes persisted tool results */
    conversationId: string;
}

/**
 * Options for completing a tool execution
 */
export interface CompleteExecutionOptions {
    /** Unique identifier for the tool call to complete */
    toolCallId: string;
    /** Result from the tool execution */
    result: unknown;
    /** Whether the execution resulted in an error */
    error: boolean;
    /** Public key of the agent that executed the tool */
    agentPubkey: string;
    /** Conversation ID that scopes persisted tool results */
    conversationId?: string;
}

/**
 * Manages the lifecycle and state of tool executions during LLM streaming
 */
export class ToolExecutionTracker {
    /**
     * Internal storage for tracked executions
     * Key: toolCallId, Value: execution state and metadata
     */
    private executions = new Map<string, TrackedExecution>();
    private fullResultStash?: FullResultStash;

    /**
     * Set the stash that holds full (pre-truncation) tool results.
     * Called once per execution from setupStreamExecution.
     */
    setFullResultStash(stash: FullResultStash): void {
        this.fullResultStash = stash;
    }

    /**
     * Track a new tool execution when it starts.
     *
     * Called when the LLM decides to execute a tool. Records the execution
     * for later correlation with results and persistence.
     */
    trackExecution(options: TrackExecutionOptions): void {
        const { toolCallId, toolName, args, conversationId } = options;

        logger.debug("[ToolExecutionTracker] Tracking new tool execution", {
            toolName,
            toolCallId,
            currentTrackedCount: this.executions.size,
        });

        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
            const argsPreview =
                typeof args === "object" && args !== null
                    ? JSON.stringify(args).substring(0, 200)
                    : String(args).substring(0, 200);

            activeSpan.addEvent("tool.execution_start", {
                "tool.name": toolName,
                "tool.call_id": toolCallId,
                "tool.args_preview": argsPreview,
            });
        }

        this.executions.set(toolCallId, {
            toolCallId,
            toolName,
            conversationId,
            toolEventId: "",
            input: args,
            completed: false,
        });
    }

    /**
     * Record the Nostr event ID published for this tool call.
     *
     * Called by ToolUsePublishingWrapper after it publishes the tool_use event,
     * inside the AI SDK's awaited execute() call — so this always runs before
     * the tool-did-execute listener fires.
     */
    setToolEventId(toolCallId: string, toolEventId: string): void {
        const execution = this.executions.get(toolCallId);
        if (execution) {
            execution.toolEventId = toolEventId;
        }
    }

    /**
     * Complete a tracked tool execution with its result.
     *
     * Persists the complete tool message to filesystem and returns the
     * tool event ID so callers can link it to ConversationStore messages.
     */
    async completeExecution(options: CompleteExecutionOptions): Promise<string | undefined> {
        const { toolCallId, result, error, agentPubkey } = options;

        logger.debug("[ToolExecutionTracker] Completing tool execution", {
            toolCallId,
            error,
            hasResult: result !== undefined,
        });

        const execution = this.executions.get(toolCallId);

        if (!execution) {
            logger.warn("[ToolExecutionTracker] Attempted to complete unknown tool execution", {
                toolCallId,
                availableExecutions: Array.from(this.executions.keys()),
            });

            trace.getActiveSpan()?.addEvent("tool.execution_unknown", {
                "tool.call_id": toolCallId,
            });

            return undefined;
        }

        const conversationId =
            options.conversationId
            ?? execution.conversationId;
        if (!conversationId) {
            throw new Error(
                `[ToolExecutionTracker] Missing conversation ID for tool ${execution.toolName} (${toolCallId}).`
            );
        }

        if (error) {
            const errorDetails = extractErrorDetails(result);

            if (!errorDetails?.type || !errorDetails.message) {
                throw new Error(
                    `[ToolExecutionTracker] Missing error details for tool ${execution.toolName} (${toolCallId}).`
                );
            }

            logger.error("[ToolExecutionTracker] Tool execution failed", {
                toolName: execution.toolName,
                toolCallId,
                toolEventId: execution.toolEventId,
                errorType: errorDetails.type,
                errorMessage: errorDetails.message,
                result,
            });

            trace.getActiveSpan()?.addEvent("tool.execution_error", {
                "tool.name": execution.toolName,
                "tool.call_id": toolCallId,
                "tool.error": true,
                "tool.error_type": errorDetails.type,
                "tool.error_message": errorDetails.message.substring(0, 200),
            });
        }

        execution.output = result;
        execution.error = error;
        execution.completed = true;

        trace.getActiveSpan()?.addEvent("tool.execution_complete", {
            "tool.name": execution.toolName,
            "tool.call_id": toolCallId,
            "tool.error": error,
            "tool.result_preview":
                typeof result === "object" && result !== null
                    ? JSON.stringify(result).substring(0, 200)
                    : String(result).substring(0, 200),
        });

        // If the tool output was truncated, recover the full result from the stash
        // so ToolMessageStorage persists the complete output (retrievable via fs_read).
        const persistedResult = this.fullResultStash?.consume(toolCallId) ?? result;

        await toolMessageStorage.store(
            conversationId,
            {
                toolCallId,
                toolName: execution.toolName,
                input: execution.input,
            },
            {
                toolCallId,
                toolName: execution.toolName,
                output: persistedResult,
                error,
            },
            agentPubkey
        );

        logger.debug("[ToolExecutionTracker] Tool execution completed and persisted", {
            toolCallId,
            toolName: execution.toolName,
            toolEventId: execution.toolEventId,
            error,
        });

        return execution.toolEventId;
    }

    /**
     * Get the current state of a tracked execution
     */
    getExecution(toolCallId: string): TrackedExecution | undefined {
        return this.executions.get(toolCallId);
    }

    /**
     * Get all tracked executions
     */
    getAllExecutions(): Map<string, TrackedExecution> {
        return new Map(this.executions);
    }

    /**
     * Check if a tool execution is being tracked
     */
    isTracking(toolCallId: string): boolean {
        return this.executions.has(toolCallId);
    }

    /**
     * Get statistics about tracked executions
     */
    getStats(): {
        total: number;
        pending: number;
        completed: number;
        failed: number;
    } {
        let pending = 0;
        let completed = 0;
        let failed = 0;

        for (const execution of this.executions.values()) {
            if (!execution.completed) {
                pending++;
            } else if (execution.error) {
                failed++;
            } else {
                completed++;
            }
        }

        return {
            total: this.executions.size,
            pending,
            completed,
            failed,
        };
    }

    /**
     * Clear all tracked executions
     */
    clear(): void {
        const previousSize = this.executions.size;
        this.executions.clear();
        this.fullResultStash?.clear();

        logger.debug("[ToolExecutionTracker] Cleared all tracked executions", {
            previousSize,
        });
    }

    /**
     * Get a summary of pending executions for debugging
     */
    getPendingExecutions(): Array<{
        toolCallId: string;
        toolName: string;
        startedAt: string;
    }> {
        const pending: Array<{
            toolCallId: string;
            toolName: string;
            startedAt: string;
        }> = [];

        for (const [toolCallId, execution] of this.executions) {
            if (!execution.completed) {
                pending.push({
                    toolCallId,
                    toolName: execution.toolName,
                    startedAt: shortenEventId(execution.toolEventId),
                });
            }
        }

        return pending;
    }

    /**
     * Get the names of recently executed tools.
     * Returns the most recent tool names (up to 10) for diagnostics/context.
     */
    getRecentToolNames(): string[] {
        const toolNames: string[] = [];

        for (const execution of this.executions.values()) {
            toolNames.push(execution.toolName);
        }

        return toolNames.slice(-10);
    }
}
