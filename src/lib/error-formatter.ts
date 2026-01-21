// ToolError removed - define it locally if needed
interface ToolError {
    kind: "validation" | "execution" | "system";
    message: string;
    field?: string;
    tool?: string;
}

/**
 * Comprehensive error formatter that handles all error types in the codebase
 * Consolidates error formatting logic from various parts of the system
 */
export function formatAnyError(error: unknown): string {
    // Handle null/undefined
    if (error == null) {
        return "Unknown error";
    }

    // Handle strings
    if (typeof error === "string") {
        return error;
    }

    // Handle Error instances
    if (error instanceof Error) {
        return error.message;
    }

    // Handle objects
    if (typeof error === "object") {
        const errorObj = error as Record<string, unknown>;

        // Check for ToolError structure (with type guard)
        if ("kind" in errorObj && "message" in errorObj) {
            const kind = errorObj.kind;
            if (kind === "validation" || kind === "execution" || kind === "system") {
                return formatToolError(errorObj as unknown as ToolError);
            }
        }

        // Check for simple message property
        if ("message" in errorObj && typeof errorObj.message === "string") {
            return errorObj.message;
        }

        // Try to extract meaningful properties from the error object
        const parts: string[] = [];

        // Common error properties
        if ("kind" in errorObj) parts.push(`kind: ${errorObj.kind}`);
        if ("field" in errorObj) parts.push(`field: ${errorObj.field}`);
        if ("tool" in errorObj) parts.push(`tool: ${errorObj.tool}`);
        if ("code" in errorObj) parts.push(`code: ${errorObj.code}`);
        if ("statusCode" in errorObj) parts.push(`statusCode: ${errorObj.statusCode}`);
        if ("errno" in errorObj) parts.push(`errno: ${errorObj.errno}`);
        if ("syscall" in errorObj) parts.push(`syscall: ${errorObj.syscall}`);

        // If we found specific properties, use them
        if (parts.length > 0) {
            return parts.join(", ");
        }

        // Otherwise, try to stringify the object
        try {
            const str = JSON.stringify(error);
            // Don't return huge JSON strings
            if (str.length > 200) {
                return "[Complex Error Object]";
            }
            return str;
        } catch {
            return "[Complex Error Object]";
        }
    }

    // Fallback to String conversion
    return String(error);
}

/**
 * Format ToolError objects into human-readable strings
 */
export function formatToolError(error: ToolError): string {
    switch (error.kind) {
        case "validation":
            // If the field is empty and message is just "Required", make it clearer
            if (error.field === "" && error.message === "Required") {
                return "Validation error: Missing required parameter";
            }
            return error.field
                ? `Validation error in ${error.field}: ${error.message}`
                : `Validation error: ${error.message}`;
        case "execution":
            return error.tool
                ? `Execution error in ${error.tool}: ${error.message}`
                : `Execution error: ${error.message}`;
        case "system":
            return `System error: ${error.message}`;
        default: {
            // This should never happen with proper ToolError types
            const unknownError = error as unknown as Record<string, unknown>;
            return (
                (typeof unknownError.message === "string" ? unknownError.message : null) ||
                "Unknown error"
            );
        }
    }
}

// Constants for AI error markers
const AI_API_CALL_ERROR = "AI_APICallError";
const PROVIDER_RETURNED_ERROR = "Provider returned error";
const OPENROUTER_MARKER = "openrouter";
const HTTP_422_STATUS = "422";

/**
 * Generic prefixes that indicate the message itself is not meaningful
 * and we should try to extract details from toString() instead.
 * These will be checked with startsWith, so "AI_APICallError" will match
 * "AI_APICallError: some details" etc.
 */
const GENERIC_ERROR_PREFIXES = [
    AI_API_CALL_ERROR,
    PROVIDER_RETURNED_ERROR,
    HTTP_422_STATUS,
    "Unprocessable Entity",
    "Error:",
] as const;

/**
 * Check if an error message is meaningful enough to use directly,
 * or if it's a generic wrapper that requires regex extraction for details.
 *
 * A message is considered "meaningful" if:
 * 1. It's not empty
 * 2. It doesn't start with any known generic prefix
 * 3. It's not just the error class name
 */
export function isMeaningfulAiMessage(message: string | undefined): boolean {
    if (!message || message.trim() === "") {
        return false;
    }

    const trimmedMessage = message.trim();

    // Check if message starts with any generic prefix
    for (const prefix of GENERIC_ERROR_PREFIXES) {
        if (trimmedMessage.startsWith(prefix)) {
            return false;
        }
    }

    // Check for HTTP status code patterns (e.g., "422", "500 Internal Server Error")
    if (/^\d{3}\b/.test(trimmedMessage)) {
        return false;
    }

    return true;
}

/**
 * Format error for stream/execution errors from LLM providers
 */
export function formatStreamError(error: unknown): { message: string; errorType: string } {
    let errorMessage = "An error occurred while processing your request.";
    let errorType = "system";

    if (error instanceof Error) {
        const errorStr = error.toString();
        if (
            errorStr.includes(AI_API_CALL_ERROR) ||
            errorStr.includes(PROVIDER_RETURNED_ERROR) ||
            errorStr.includes(HTTP_422_STATUS) ||
            errorStr.includes(OPENROUTER_MARKER)
        ) {
            errorType = "ai_api";

            // Check if error.message is meaningful (not a generic wrapper)
            // Claude Code errors often have the real error in error.message
            if (isMeaningfulAiMessage(error.message)) {
                errorMessage = `AI Error: ${error.message}`;
            } else {
                // Fall back to regex extraction for OpenRouter-style errors
                const providerMatch = errorStr.match(/provider_name":"([^"]+)"/);
                const provider = providerMatch ? providerMatch[1] : "AI provider";
                errorMessage = `Failed to process request with ${provider}. The AI service returned an error.`;

                // Add raw error details if available
                const rawMatch = errorStr.match(/raw":"([^"]+)"/);
                if (rawMatch) {
                    errorMessage += ` Details: ${rawMatch[1]}`;
                }
            }
        } else {
            errorMessage = `Error: ${error.message}`;
        }
    }

    return { message: errorMessage, errorType };
}
