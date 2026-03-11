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
