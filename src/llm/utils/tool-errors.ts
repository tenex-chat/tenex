import { formatAnyError } from "@/lib/error-formatter";
import type { AISdkTool } from "@/tools/types";
import type { InvalidToolCall } from "@/llm/types";
import type { StepResult } from "ai";

/**
 * Extract invalid tool calls from step results.
 * Used to detect and report dynamic tool validation errors.
 */
export function getInvalidToolCalls(
    steps: StepResult<Record<string, AISdkTool>>[]
): InvalidToolCall[] {
    return steps.flatMap((step, index) => getInvalidToolCallsFromStep(step, index));
}

export function getInvalidToolCallsFromStep(
    step: StepResult<Record<string, AISdkTool>>,
    fallbackStepNumber = 0
): InvalidToolCall[] {
    if (!step.toolCalls) {
        return [];
    }

    const stepNumber =
        typeof step.stepNumber === "number" ? step.stepNumber : fallbackStepNumber;
    const invalidToolCalls: InvalidToolCall[] = [];

    for (const [toolCallIndex, toolCall] of step.toolCalls.entries()) {
        if (
            "dynamic" in toolCall &&
            toolCall.dynamic === true &&
            toolCall.invalid === true &&
            toolCall.error
        ) {
            invalidToolCalls.push({
                stepNumber,
                toolCallIndex,
                toolName: toolCall.toolName,
                toolCallId:
                    typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined,
                errorType: getInvalidToolCallErrorType(toolCall.error),
                errorMessage: formatAnyError(toolCall.error) || "Unknown error",
                input: "input" in toolCall ? toolCall.input : undefined,
            });
        }
    }

    return invalidToolCalls;
}

function getInvalidToolCallErrorType(error: unknown): string {
    if (error instanceof Error) {
        return error.name || error.constructor.name || "Error";
    }

    if (typeof error === "object" && error !== null) {
        const namedError = error as { name?: unknown; constructor?: { name?: unknown } };
        if (typeof namedError.name === "string" && namedError.name.length > 0) {
            return namedError.name;
        }
        if (
            typeof namedError.constructor?.name === "string" &&
            namedError.constructor.name.length > 0
        ) {
            return namedError.constructor.name;
        }
    }

    return typeof error === "string" && error.length > 0 ? "Error" : "UnknownError";
}

/**
 * Check if a tool result indicates an error.
 * AI SDK wraps tool execution errors in error-text or error-json formats.
 * Some tests and mock providers also surface plain "error" objects.
 */
export function isToolResultError(result: unknown): boolean {
    if (typeof result !== "object" || result === null) {
        return false;
    }
    const res = result as Record<string, unknown>;
    // Check for AI SDK's known error formats plus the mock-provider fallback.
    return (
        (res.type === "error-text" && typeof res.text === "string") ||
        (res.type === "error-json" && typeof res.json === "object") ||
        (res.type === "error" &&
            (typeof res.message === "string" ||
                res.error instanceof Error ||
                typeof res.error === "string"))
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

    if (res.type === "error") {
        const message =
            typeof res.message === "string"
                ? res.message
                : res.error instanceof Error
                  ? res.error.message
                  : typeof res.error === "string"
                    ? res.error
                    : "Unknown error";
        return { message, type: "error" };
    }

    return null;
}
