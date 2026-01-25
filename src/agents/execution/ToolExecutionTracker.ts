/**
 * ToolExecutionTracker - Manages tool execution lifecycle during LLM streaming.
 *
 * Tracks executions from start to completion, coordinating between async events and
 * ensuring proper correlation between Nostr events, tool results, and persistence.
 *
 * Responsibilities:
 * - Event Correlation: Matches tool results with their initial execution events
 * - Nostr Publishing: Publishes tool execution announcements
 * - Persistence: Stores tool messages for conversation history
 */

import { isDelegateToolName, unwrapMcpToolName } from "@/agents/tool-names";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import { PendingDelegationsRegistry } from "@/services/ral";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import { extractErrorDetails, getHumanReadableContent } from "./ToolResultUtils";

/**
 * Tools that publish addressable events and need delayed tool use event publishing.
 * These tools return results containing addressable event references that should be
 * tagged with 'a' tags on the tool use event.
 */
const ADDRESSABLE_EVENT_TOOLS = ["report_write"];

/**
 * Check if a tool publishes addressable events that need delayed publishing.
 * This includes both direct tool names and MCP-wrapped versions.
 */
function isAddressableEventTool(toolName: string): boolean {
    const baseToolName = unwrapMcpToolName(toolName);
    return ADDRESSABLE_EVENT_TOOLS.includes(baseToolName);
}

function needsDelayedPublishing(toolName: string): boolean {
    return isDelegateToolName(toolName) || isAddressableEventTool(toolName);
}

/**
 * Represents a tracked tool execution
 */
interface TrackedExecution {
    /** Unique identifier for this tool call */
    toolCallId: string;
    /** Name of the tool being executed */
    toolName: string;
    /** Nostr event ID published when tool started (empty string for delegation tools with delayed publishing) */
    toolEventId: string;
    /** Input arguments passed to the tool */
    input: unknown;
    /** Output from the tool (available after completion) */
    output?: unknown;
    /** Whether the tool execution resulted in an error */
    error?: boolean;
    /** Whether the tool has completed execution */
    completed: boolean;
    /** Human-readable content for the tool event (stored for delayed publishing) */
    humanContent?: string;
    /** Event context for publishing (stored for delayed publishing) */
    eventContext?: EventContext;
    /** Agent publisher instance (stored for delayed publishing) */
    agentPublisher?: AgentPublisher;
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
    /** Available tools for human-readable content generation */
    toolsObject: Record<string, AISdkTool>;
    /** Publisher for Nostr events */
    agentPublisher: AgentPublisher;
    /** Context for event publishing */
    eventContext: EventContext;
    /** Cumulative usage from previous steps (if available) */
    usage?: import("@/llm/types").LanguageModelUsageWithCostUsd;
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

    /**
     * Track a new tool execution when it starts
     *
     * This method is called when the LLM decides to execute a tool. It:
     * 1. Generates human-readable content for the tool execution
     * 2. Publishes a Nostr event announcing the tool execution (unless delegation tool)
     * 3. Stores the execution state for later correlation with results
     *
     * For delegation tools (delegate, delegate_followup, ask, delegate_crossproject),
     * publishing is delayed until completeExecution so the delegation event IDs can be included.
     *
     * @param options - Configuration for tracking the execution
     * @returns Promise that resolves with the published Nostr event, or null for delegation tools
     *
     * @throws Will throw if Nostr event publishing fails
     */
    async trackExecution(options: TrackExecutionOptions): Promise<NDKEvent | null> {
        const { toolCallId, toolName, args, toolsObject, agentPublisher, eventContext, usage } = options;

        logger.debug("[ToolExecutionTracker] Tracking new tool execution", {
            toolName,
            toolCallId,
            currentTrackedCount: this.executions.size,
        });

        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
            // Truncate args for telemetry to prevent huge span attributes
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

        // Generate human-readable content for the tool execution
        const humanContent = getHumanReadableContent(toolName, args, toolsObject);

        // Store the execution state BEFORE async operations to prevent race conditions
        const execution: TrackedExecution = {
            toolCallId,
            toolName,
            toolEventId: "", // Will be updated after publish (empty for delayed delegation tools)
            input: args,
            completed: false,
        };

        this.executions.set(toolCallId, execution);

        // For tools that need delayed publishing (delegation tools, addressable event tools),
        // delay publishing until completion so we have the event IDs/references
        if (needsDelayedPublishing(toolName)) {
            // Store context for delayed publishing in completeExecution
            execution.humanContent = humanContent;
            execution.eventContext = eventContext;
            execution.agentPublisher = agentPublisher;

            const toolType = isDelegateToolName(toolName) ? "delegation" : "addressable event";
            logger.debug(`[ToolExecutionTracker] ${toolType} tool tracked (delayed publishing)`, {
                toolCallId,
                toolName,
                totalTracked: this.executions.size,
            });

            return null;
        }

        // Publish the tool execution event to Nostr (async operation)
        const toolEvent = await agentPublisher.toolUse(
            {
                toolName,
                content: humanContent,
                args,
                usage,
            },
            eventContext
        );

        // Update the execution with the actual event ID
        execution.toolEventId = toolEvent.id;

        logger.debug("[ToolExecutionTracker] Tool execution tracked", {
            toolCallId,
            toolName,
            toolEventId: toolEvent.id,
            totalTracked: this.executions.size,
        });

        return toolEvent;
    }

    /**
     * Complete a tracked tool execution with its result
     *
     * This method is called when a tool finishes executing. It:
     * 1. Retrieves the original execution metadata
     * 2. Updates the execution state with results
     * 3. Persists the complete tool message to filesystem
     *
     * @param options - Configuration for completing the execution
     * @returns Promise that resolves with the tool event ID (for linking to ConversationStore messages)
     *
     * @remarks
     * If the toolCallId is not found (e.g., due to a race condition or error),
     * this method logs a warning but does not throw an error
     */
    async completeExecution(options: CompleteExecutionOptions): Promise<string | undefined> {
        const { toolCallId, result, error, agentPubkey } = options;

        logger.debug("[ToolExecutionTracker] Completing tool execution", {
            toolCallId,
            error,
            hasResult: result !== undefined,
        });

        // Retrieve the tracked execution
        const execution = this.executions.get(toolCallId);

        if (!execution) {
            logger.warn("[ToolExecutionTracker] Attempted to complete unknown tool execution", {
                toolCallId,
                availableExecutions: Array.from(this.executions.keys()),
            });

            const activeSpan = trace.getActiveSpan();
            if (activeSpan) {
                activeSpan.addEvent("tool.execution_unknown", {
                    "tool.call_id": toolCallId,
                });
            }

            return undefined;
        }

        // Log errors explicitly for visibility
        if (error) {
            // Extract error details for better logging
            const errorDetails = extractErrorDetails(result);

            logger.error("[ToolExecutionTracker] Tool execution failed", {
                toolName: execution.toolName,
                toolCallId,
                toolEventId: execution.toolEventId,
                errorType: errorDetails?.type || "unknown",
                errorMessage: errorDetails?.message || "No details available",
                result,
            });

            // IMPORTANT: Log error event in telemetry for trace analysis
            const activeSpan = trace.getActiveSpan();
            activeSpan?.addEvent("tool.execution_error", {
                "tool.name": execution.toolName,
                "tool.call_id": toolCallId,
                "tool.error": true,
                "tool.error_type": errorDetails?.type || "unknown",
                "tool.error_message": (errorDetails?.message || "").substring(0, 200),
            });
        }

        // Update execution state
        execution.output = result;
        execution.error = error;
        execution.completed = true;

        // For tools with delayed publishing, publish the tool use event now with references
        if (execution.toolEventId === "" && execution.agentPublisher && execution.eventContext) {
            let referencedEventIds: string[] = [];
            let referencedAddressableEvents: string[] = [];

            const conversationId = execution.eventContext?.conversationId;
            if (conversationId) {
                if (isDelegateToolName(execution.toolName)) {
                    // Consume delegation event IDs from registry (registered in AgentPublisher.ask/delegate)
                    referencedEventIds = PendingDelegationsRegistry.consume(agentPubkey, conversationId);
                } else if (isAddressableEventTool(execution.toolName)) {
                    // Consume addressable event references from registry (registered in report_write tool)
                    referencedAddressableEvents = PendingDelegationsRegistry.consumeAddressable(agentPubkey, conversationId);
                }
            }

            // Publish the delayed tool use event with references
            const toolEvent = await execution.agentPublisher.toolUse(
                {
                    toolName: execution.toolName,
                    content: execution.humanContent || `Executed ${execution.toolName}`,
                    args: execution.input,
                    referencedEventIds,
                    referencedAddressableEvents,
                },
                execution.eventContext
            );

            execution.toolEventId = toolEvent.id;

            const logDetails: Record<string, unknown> = {
                toolCallId,
                toolName: execution.toolName,
                toolEventId: toolEvent.id,
            };
            if (referencedEventIds.length > 0) {
                logDetails.referencedEventIds = referencedEventIds;
            }
            if (referencedAddressableEvents.length > 0) {
                logDetails.referencedAddressableEvents = referencedAddressableEvents;
            }

            logger.debug("[ToolExecutionTracker] Tool event published with references", logDetails);
        }

        // Add telemetry for tool completion
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
            // Truncate result for telemetry
            const resultPreview =
                typeof result === "object" && result !== null
                    ? JSON.stringify(result).substring(0, 200)
                    : String(result).substring(0, 200);

            activeSpan.addEvent("tool.execution_complete", {
                "tool.name": execution.toolName,
                "tool.call_id": toolCallId,
                "tool.error": error,
                "tool.result_preview": resultPreview,
            });
        }

        // Persist the complete tool message to filesystem
        // This enables conversation reconstruction and audit trails
        await toolMessageStorage.store(
            execution.toolEventId,
            {
                toolCallId,
                toolName: execution.toolName,
                input: execution.input,
            },
            {
                toolCallId,
                toolName: execution.toolName,
                output: result,
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

        // Return the tool event ID so callers can link it to ConversationStore messages
        return execution.toolEventId;
    }

    /**
     * Get the current state of a tracked execution
     *
     * @param toolCallId - Unique identifier of the tool call
     * @returns The tracked execution or undefined if not found
     */
    getExecution(toolCallId: string): TrackedExecution | undefined {
        return this.executions.get(toolCallId);
    }

    /**
     * Get all tracked executions
     *
     * @returns Map of all tracked executions
     */
    getAllExecutions(): Map<string, TrackedExecution> {
        return new Map(this.executions);
    }

    /**
     * Check if a tool execution is being tracked
     *
     * @param toolCallId - Unique identifier of the tool call
     * @returns True if the execution is being tracked
     */
    isTracking(toolCallId: string): boolean {
        return this.executions.has(toolCallId);
    }

    /**
     * Get statistics about tracked executions
     *
     * @returns Object containing execution statistics
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
     *
     * @remarks
     * This should typically only be called between independent agent executions
     * to prevent memory leaks from accumulating execution records
     */
    clear(): void {
        const previousSize = this.executions.size;
        this.executions.clear();

        logger.debug("[ToolExecutionTracker] Cleared all tracked executions", {
            previousSize,
        });
    }

    /**
     * Get a summary of pending executions for debugging
     *
     * @returns Array of pending execution summaries
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
                    startedAt: execution.toolEventId.substring(0, 8), // First 8 chars of event ID
                });
            }
        }

        return pending;
    }

    /**
     * Get the names of recently executed tools.
     * Returns the most recent tool names (up to 10) for diagnostics/context.
     *
     * @returns Array of tool names that have been executed
     */
    getRecentToolNames(): string[] {
        const toolNames: string[] = [];

        // Get all tool names from tracked executions
        for (const execution of this.executions.values()) {
            toolNames.push(execution.toolName);
        }

        // Return the most recent 10 (map preserves insertion order)
        return toolNames.slice(-10);
    }
}
