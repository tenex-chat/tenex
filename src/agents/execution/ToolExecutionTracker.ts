/**
 * ToolExecutionTracker - Manages the lifecycle of tool executions during LLM streaming
 *
 * This class provides a centralized way to track tool executions from start to completion,
 * coordinating between asynchronous tool execution events and ensuring proper correlation
 * between Nostr events, tool results, and filesystem persistence.
 *
 * ## Overview
 *
 * During LLM streaming, tools are executed asynchronously. When the LLM decides to use a tool:
 * 1. A 'tool-will-execute' event fires when the tool starts
 * 2. The tracker publishes a Nostr event announcing the tool execution
 * 3. The tool executes (potentially taking significant time)
 * 4. A 'tool-did-execute' event fires when the tool completes
 * 5. The tracker correlates the result with the original Nostr event
 * 6. Tool input/output is persisted to filesystem for conversation reconstruction
 *
 * ## Key Responsibilities
 *
 * - **Event Correlation**: Matches tool results with their initial execution events
 * - **Nostr Publishing**: Publishes tool execution announcements to the Nostr network
 * - **State Management**: Tracks execution state (pending → completed/failed)
 * - **Persistence**: Stores tool messages to filesystem for conversation history
 * - **Human Readability**: Generates user-friendly descriptions of tool executions
 *
 * ## Design Decisions
 *
 * - Uses a Map for O(1) lookup of executions by toolCallId
 * - Stores minimal state to reduce memory footprint
 * - Delegates Nostr publishing to AgentPublisher for separation of concerns
 * - Maintains immutability of execution records for consistency
 *
 * @example
 * ```typescript
 * const tracker = new ToolExecutionTracker();
 *
 * // When tool starts executing
 * await tracker.trackExecution({
 *   toolCallId: 'call_123',
 *   toolName: 'search',
 *   args: { query: 'TypeScript' },
 *   toolsObject: availableTools,
 *   agentPublisher: publisher,
 *   eventContext: context
 * });
 *
 * // When tool completes
 * await tracker.completeExecution({
 *   toolCallId: 'call_123',
 *   result: { results: [...] },
 *   error: false,
 *   agentPubkey: 'agent_pubkey_123'
 * });
 * ```
 */

import type { Tool as CoreTool } from "ai";
import { logger } from "@/utils/logger";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";

/**
 * Represents a tracked tool execution
 */
interface TrackedExecution {
    /** Unique identifier for this tool call */
    toolCallId: string;
    /** Name of the tool being executed */
    toolName: string;
    /** Nostr event ID published when tool started */
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
    /** Available tools for human-readable content generation */
    toolsObject: Record<string, CoreTool>;
    /** Publisher for Nostr events */
    agentPublisher: AgentPublisher;
    /** Context for event publishing */
    eventContext: EventContext;
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
 * Format MCP tool names for human readability
 * Converts "mcp__repomix__pack_codebase" to "repomix's pack_codebase"
 */
function formatMCPToolName(toolName: string): string {
    if (!toolName.startsWith('mcp__')) {
        return toolName;
    }

    // Split the MCP tool name: mcp__<server>__<tool>
    const parts = toolName.split('__');
    if (parts.length !== 3) {
        return toolName;
    }

    const [, serverName, toolMethod] = parts;

    // Simple format: server's tool_name
    return `${serverName}'s ${toolMethod.replace(/_/g, ' ')}`;
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
     * 2. Publishes a Nostr event announcing the tool execution
     * 3. Stores the execution state for later correlation with results
     *
     * @param options - Configuration for tracking the execution
     * @returns Promise that resolves when the execution is tracked and event is published
     *
     * @throws Will throw if Nostr event publishing fails
     */
    async trackExecution(options: TrackExecutionOptions): Promise<void> {
        const { toolCallId, toolName, args, toolsObject, agentPublisher, eventContext } = options;

        logger.info('[ToolExecutionTracker] Tracking new tool execution', {
            toolName,
            toolCallId,
            currentTrackedCount: this.executions.size
        });

        // Generate human-readable content for the tool execution
        const humanContent = this.getHumanReadableContent(toolName, args, toolsObject);

        // Store the execution state BEFORE async operations to prevent race conditions
        // Use a placeholder event ID that will be updated after publishing
        const execution: TrackedExecution = {
            toolCallId,
            toolName,
            toolEventId: '', // Will be updated after publish
            input: args,
            completed: false
        };

        this.executions.set(toolCallId, execution);

        // Publish the tool execution event to Nostr (async operation)
        const toolEvent = await agentPublisher.toolUse(
            {
                toolName,
                content: humanContent,
                args
            },
            eventContext
        );

        // Update the execution with the actual event ID
        execution.toolEventId = toolEvent.id;

        logger.debug('[ToolExecutionTracker] Tool execution tracked', {
            toolCallId,
            toolName,
            toolEventId: toolEvent.id,
            totalTracked: this.executions.size
        });
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
     * @returns Promise that resolves when the execution is completed and persisted
     *
     * @remarks
     * If the toolCallId is not found (e.g., due to a race condition or error),
     * this method logs a warning but does not throw an error
     */
    async completeExecution(options: CompleteExecutionOptions): Promise<void> {
        const { toolCallId, result, error, agentPubkey } = options;

        logger.info('[ToolExecutionTracker] Completing tool execution', {
            toolCallId,
            error,
            hasResult: result !== undefined
        });

        // Retrieve the tracked execution
        const execution = this.executions.get(toolCallId);

        if (!execution) {
            logger.warn('[ToolExecutionTracker] Attempted to complete unknown tool execution', {
                toolCallId,
                availableExecutions: Array.from(this.executions.keys())
            });
            return;
        }

        // Log errors explicitly for visibility
        if (error) {
            logger.error('[ToolExecutionTracker] Tool execution failed', {
                toolName: execution.toolName,
                toolCallId,
                toolEventId: execution.toolEventId,
                result
            });
        }

        // Update execution state
        execution.output = result;
        execution.error = error;
        execution.completed = true;

        // Persist the complete tool message to filesystem
        // This enables conversation reconstruction and audit trails
        await toolMessageStorage.store(
            execution.toolEventId,
            {
                toolCallId,
                toolName: execution.toolName,
                input: execution.input
            },
            {
                toolCallId,
                toolName: execution.toolName,
                output: result,
                error
            },
            agentPubkey
        );

        logger.debug('[ToolExecutionTracker] Tool execution completed and persisted', {
            toolCallId,
            toolName: execution.toolName,
            toolEventId: execution.toolEventId,
            error
        });
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
            failed
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

        logger.debug('[ToolExecutionTracker] Cleared all tracked executions', {
            previousSize
        });
    }

    /**
     * Generate human-readable content for a tool execution
     *
     * This method attempts to generate a user-friendly description of what the tool
     * is doing by:
     * 1. Checking if the tool has a custom getHumanReadableContent method
     * 2. For MCP tools, formatting the tool name in a readable way
     * 3. Falling back to a generic "Executing <toolname>" message
     *
     * @param toolName - Name of the tool being executed
     * @param args - Arguments passed to the tool
     * @param toolsObject - Available tools that may have custom formatters
     * @returns Human-readable description of the tool execution
     */
    private getHumanReadableContent(
        toolName: string,
        args: unknown,
        toolsObject: Record<string, CoreTool>
    ): string {
        // Check if the tool has a custom human-readable content generator
        const tool = toolsObject[toolName];
        const customContent = tool?.getHumanReadableContent?.(args);

        if (customContent) {
            return customContent;
        }

        // Special formatting for MCP tools
        if (toolName.startsWith('mcp__')) {
            return `Executing ${formatMCPToolName(toolName)}`;
        }

        // Default format
        return `Executing ${toolName}`;
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
                    startedAt: execution.toolEventId.substring(0, 8) // First 8 chars of event ID
                });
            }
        }

        return pending;
    }
}