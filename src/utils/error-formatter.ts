/**
 * Format various error types into human-readable strings
 */
export function formatToolError(error: unknown): string {
    if (typeof error === "string") {
        return error;
    } else if (error && typeof error === "object" && "message" in error) {
        return (error as { message: string }).message;
    } else if (error && typeof error === "object") {
        // Try to extract meaningful properties from the error object
        const errorObj = error as Record<string, unknown>;
        const parts: string[] = [];
        
        // Common error properties
        if ("kind" in errorObj) parts.push(`kind: ${errorObj.kind}`);
        if ("field" in errorObj) parts.push(`field: ${errorObj.field}`);
        if ("tool" in errorObj) parts.push(`tool: ${errorObj.tool}`);
        if ("code" in errorObj) parts.push(`code: ${errorObj.code}`);
        if ("statusCode" in errorObj) parts.push(`statusCode: ${errorObj.statusCode}`);
        
        // If we found specific properties, use them
        if (parts.length > 0) {
            return parts.join(", ");
        }
        
        // Otherwise, try to stringify the object
        try {
            return JSON.stringify(error);
        } catch {
            return "[Complex Error Object]";
        }
    } else {
        return String(error);
    }
}