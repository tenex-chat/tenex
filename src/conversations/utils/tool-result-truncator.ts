/**
 * ToolResultTruncator - Truncates large/old tool results to save context
 *
 * Rules:
 * - Tool results < 1k chars: never truncated
 * - Tool results > 10k chars: include inline for 3 messages, then truncate
 * - Tool results 1k-10k chars: include inline for 6 messages, then truncate
 *
 * Truncated results are replaced with a reference that allows re-reading via
 * the event ID using fs_read(tool=<eventId>).
 */

import type { ToolResultPart } from "ai";

// Thresholds for truncation
const NEVER_TRUNCATE_THRESHOLD = 1000; // 1k chars - never truncate below this
const LARGE_RESULT_THRESHOLD = 10000; // 10k chars
const LARGE_RESULT_BURIAL_LIMIT = 3; // Messages before truncation for large results
const SMALL_RESULT_BURIAL_LIMIT = 6; // Messages before truncation for small results

export interface TruncationContext {
    /** Current message index being processed */
    currentIndex: number;
    /** Total number of messages in the conversation */
    totalMessages: number;
    /** Event ID for referencing the tool result (required for truncation) */
    eventId?: string;
}

/**
 * Calculate the original size of a tool result
 */
function getToolResultSize(toolData: ToolResultPart[]): number {
    let totalSize = 0;
    for (const part of toolData) {
        const output = part.output as unknown;
        if (output) {
            if (typeof output === "string") {
                totalSize += output.length;
            } else if (typeof output === "object" && output !== null && "value" in output) {
                totalSize += String((output as { value: unknown }).value).length;
            } else {
                totalSize += JSON.stringify(output).length;
            }
        }
    }
    return totalSize;
}

/**
 * Check if a tool result should be truncated based on its size and burial depth
 */
export function shouldTruncateToolResult(
    toolData: ToolResultPart[],
    context: TruncationContext
): boolean {
    const size = getToolResultSize(toolData);

    // Never truncate small results
    if (size < NEVER_TRUNCATE_THRESHOLD) {
        return false;
    }

    // Can't truncate without an eventId to reference
    if (!context.eventId) {
        return false;
    }

    const burialDepth = context.totalMessages - context.currentIndex - 1;

    if (size > LARGE_RESULT_THRESHOLD) {
        return burialDepth >= LARGE_RESULT_BURIAL_LIMIT;
    }

    return burialDepth >= SMALL_RESULT_BURIAL_LIMIT;
}

/**
 * Create a truncated tool result that references the original by event ID
 */
export function createTruncatedToolResult(
    toolData: ToolResultPart[],
    eventId: string
): ToolResultPart[] {
    const size = getToolResultSize(toolData);

    return toolData.map((part) => ({
        type: "tool-result" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: {
            type: "text" as const,
            value: `[Tool executed, ${size} chars output truncated. Use fs_read(tool="${eventId}") to retrieve full output if needed]`,
        },
    }));
}

/**
 * Process tool result, potentially truncating if buried too deep
 */
export function processToolResult(
    toolData: ToolResultPart[],
    context: TruncationContext
): ToolResultPart[] {
    if (shouldTruncateToolResult(toolData, context) && context.eventId) {
        return createTruncatedToolResult(toolData, context.eventId);
    }
    return toolData;
}
