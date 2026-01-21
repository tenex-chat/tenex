import type { AISdkTool } from "@/tools/types";
import type { StepResult } from "ai";

/**
 * Extract invalid tool calls from step results.
 * Used to detect and report dynamic tool validation errors.
 */
export function getInvalidToolCalls(
    steps: StepResult<Record<string, AISdkTool>>[]
): Array<{ toolName: string; error: string }> {
    const invalidToolCalls: Array<{ toolName: string; error: string }> = [];

    for (const step of steps) {
        if (step.toolCalls) {
            for (const toolCall of step.toolCalls) {
                // Check if this is a dynamic tool call that's invalid
                if (
                    "dynamic" in toolCall &&
                    toolCall.dynamic === true &&
                    toolCall.invalid === true &&
                    toolCall.error
                ) {
                    const error =
                        typeof toolCall.error === "object" &&
                        toolCall.error !== null &&
                        "name" in toolCall.error
                            ? (toolCall.error as { name: string }).name
                            : "Unknown error";
                    invalidToolCalls.push({
                        toolName: toolCall.toolName,
                        error,
                    });
                }
            }
        }
    }

    return invalidToolCalls;
}

/**
 * Check if a tool result indicates an error.
 * AI SDK wraps tool execution errors in error-text or error-json formats.
 */
export function isToolResultError(result: unknown): boolean {
    if (typeof result !== "object" || result === null) {
        return false;
    }
    const res = result as Record<string, unknown>;
    // Check for AI SDK's known error formats
    return (
        (res.type === "error-text" && typeof res.text === "string") ||
        (res.type === "error-json" && typeof res.json === "object")
    );
}

/**
 * Extract error details from tool result for better logging.
 * Returns null if the result is not an error format.
 */
export function extractErrorDetails(result: unknown): { message: string; type: string } | null {
    if (typeof result !== "object" || result === null) {
        return null;
    }
    const res = result as Record<string, unknown>;

    if (res.type === "error-text" && typeof res.text === "string") {
        return { message: res.text, type: "error-text" };
    }

    if (res.type === "error-json" && typeof res.json === "object") {
        const errorJson = res.json as Record<string, unknown>;
        const message = errorJson.message || errorJson.error || JSON.stringify(errorJson);
        return { message: String(message), type: "error-json" };
    }

    return null;
}
