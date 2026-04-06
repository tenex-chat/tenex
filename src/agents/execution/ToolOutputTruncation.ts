/**
 * Tool Output Truncation - Intercepts tool results to cap what the LLM sees.
 *
 * Large tool outputs (shell commands, grep results) waste tokens. This wrapper
 * truncates results above a threshold while stashing full results for retrieval
 * via fs_read(tool: "toolCallId"). The FullResultStash bridges the truncated
 * LLM path with the full-result persistence path in ToolMessageStorage.
 */

import type { ToolExecutionOptions } from "@ai-sdk/provider-utils";
import type { Tool as CoreTool } from "ai";

/** Results larger than this (in chars) get truncated for the LLM */
export const TOOL_OUTPUT_TRUNCATION_THRESHOLD = 10_000;

/** Number of chars to include as a preview in the truncation placeholder */
const PREVIEW_LENGTH = 500;

/**
 * Per-execution stash that holds full tool results between truncation (in the
 * tool wrapper) and persistence (in ToolExecutionTracker.completeExecution).
 *
 * Scoped to a single execution — created in setupStreamExecution, consumed in
 * completeExecution, GC'd when execution ends.
 */
export class FullResultStash {
    private entries = new Map<string, string>();

    /** Store the full serialized result for a tool call. */
    stash(toolCallId: string, fullResult: string): void {
        this.entries.set(toolCallId, fullResult);
    }

    /** Retrieve and remove the full result. Returns undefined if not stashed. */
    consume(toolCallId: string): string | undefined {
        const result = this.entries.get(toolCallId);
        if (result !== undefined) {
            this.entries.delete(toolCallId);
        }
        return result;
    }

    /** Clear all stashed entries. */
    clear(): void {
        this.entries.clear();
    }
}

/**
 * Serialize a tool result to a string for length measurement and truncation.
 * Strings pass through, objects are JSON-stringified, null/undefined become "".
 */
export function serializeToolResult(result: unknown): string {
    if (result === null || result === undefined) {
        return "";
    }
    if (typeof result === "string") {
        return result;
    }
    return JSON.stringify(result);
}

/**
 * Build the truncation placeholder the LLM sees instead of the full result.
 * Aligns with the existing buildDecayPlaceholder convention so the LLM knows
 * to use fs_read(tool: "...") for retrieval.
 */
export function buildTruncationPlaceholder(
    toolName: string,
    toolCallId: string,
    preview: string,
    originalLength: number
): string {
    const remaining = originalLength - preview.length;
    return [
        `[${toolName} result truncated (${originalLength} chars) -- use fs_read(tool: "${toolCallId}") to retrieve full output]`,
        "",
        "--- Preview ---",
        preview,
        `... [${remaining} more chars]`,
    ].join("\n");
}

/**
 * Wrap every tool's execute() to truncate large results for the LLM while
 * stashing full results for persistence via ToolMessageStorage.
 *
 * Applied BEFORE the supervision wrapper so truncation is the inner layer:
 *   Tool.execute() → truncation → supervision → AI SDK
 */
export function wrapToolsWithOutputTruncation(
    toolsObject: Record<string, CoreTool<unknown, unknown>>,
    stash: FullResultStash
): Record<string, CoreTool<unknown, unknown>> {
    const wrappedTools: Record<string, CoreTool<unknown, unknown>> = {};

    /** Tools from ai-sdk-fs-tools that have their own built-in truncation */
    const FS_TOOL_NAMES = new Set(["fs_read", "fs_glob", "fs_grep"]);

    for (const [toolName, tool] of Object.entries(toolsObject)) {
        // Skip tools without an execute function
        if (!tool.execute) {
            wrappedTools[toolName] = tool;
            continue;
        }

        // Skip ai-sdk-fs-tools — they have their own line-based truncation
        // (DEFAULT_LINE_LIMIT=250, MAX_LINE_LENGTH=2000). Wrapping them would
        // double-truncate, and wrapping fs_read's retrieval results would
        // create an infinite loop where the agent can never retrieve full output.
        if (FS_TOOL_NAMES.has(toolName)) {
            wrappedTools[toolName] = tool;
            continue;
        }

        const originalExecute = tool.execute.bind(tool);

        wrappedTools[toolName] = {
            ...tool,
            execute: async (input: unknown, options: ToolExecutionOptions) => {
                const result = await originalExecute(input, options);

                const serialized = serializeToolResult(result);
                if (serialized.length <= TOOL_OUTPUT_TRUNCATION_THRESHOLD) {
                    return result;
                }

                // Stash the full result for ToolExecutionTracker to persist
                stash.stash(options.toolCallId, serialized);

                // Return truncated placeholder to the LLM
                const preview = serialized.substring(0, PREVIEW_LENGTH);
                return buildTruncationPlaceholder(toolName, options.toolCallId, preview, serialized.length);
            },
        };
    }

    return wrappedTools;
}
