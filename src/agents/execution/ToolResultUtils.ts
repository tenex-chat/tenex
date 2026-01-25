import { formatMcpToolName } from "@/agents/tool-names";
import type { AISdkTool } from "@/tools/types";

/**
 * Error details extracted from tool results
 */
export interface ExtractedErrorDetails {
    message: string;
    type: string;
}

/**
 * Extract error details from a tool result for better logging and telemetry.
 * Handles various error result formats from AI SDK and shell tool.
 *
 * @param result - The tool result that may contain error information
 * @returns Error details or null if not an error result
 */
export function extractErrorDetails(result: unknown): ExtractedErrorDetails | null {
    if (typeof result !== "object" || result === null) {
        return null;
    }

    const res = result as Record<string, unknown>;

    // AI SDK error-text format
    if (res.type === "error-text" && typeof res.text === "string") {
        return { message: res.text, type: "error-text" };
    }

    // AI SDK error-json format
    if (res.type === "error-json" && typeof res.json === "object") {
        const errorJson = res.json as Record<string, unknown>;
        const message = errorJson.message || errorJson.error || JSON.stringify(errorJson);
        return { message: String(message), type: "error-json" };
    }

    // Shell tool structured error format
    if (res.type === "shell-error") {
        const shellError = res as {
            error?: string;
            exitCode?: number | null;
            stderr?: string;
        };
        const message = shellError.error ||
            shellError.stderr ||
            `Exit code: ${shellError.exitCode}`;
        return { message, type: "shell-error" };
    }

    // Generic error object with message property
    if (typeof res.error === "string") {
        return { message: res.error, type: "generic" };
    }

    if (typeof res.message === "string") {
        return { message: res.message, type: "generic" };
    }

    return null;
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
export function getHumanReadableContent(
    toolName: string,
    args: unknown,
    toolsObject: Record<string, AISdkTool>
): string {
    // Check if the tool has a custom human-readable content generator
    const tool = toolsObject[toolName];
    const customContent = tool?.getHumanReadableContent?.(args);

    if (customContent) {
        return customContent;
    }

    // Special formatting for MCP tools
    if (toolName.startsWith("mcp__")) {
        return `Executing ${formatMcpToolName(toolName)}`;
    }

    // Default format
    return `Executing ${toolName}`;
}
