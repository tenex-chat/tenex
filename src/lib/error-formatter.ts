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

/**
 * Format error for stream/execution errors from LLM providers
 */
export function formatStreamError(error: unknown): { message: string; errorType: string } {
    let errorMessage = "An error occurred while processing your request.";
    let errorType = "system";

    if (error instanceof Error) {
        const errorStr = error.toString();
        if (
            errorStr.includes("AI_APICallError") ||
            errorStr.includes("Provider returned error") ||
            errorStr.includes("422") ||
            errorStr.includes("openrouter")
        ) {
            errorType = "ai_api";

            // Extract meaningful error details
            const providerMatch = errorStr.match(/provider_name":"([^"]+)"/);
            const provider = providerMatch ? providerMatch[1] : "AI provider";
            errorMessage = `Failed to process request with ${provider}. The AI service returned an error.`;

            // Add raw error details if available
            const rawMatch = errorStr.match(/raw":"([^"]+)"/);
            if (rawMatch) {
                errorMessage += ` Details: ${rawMatch[1]}`;
            }
        } else {
            errorMessage = `Error: ${error.message}`;
        }
    }

    return { message: errorMessage, errorType };
}
