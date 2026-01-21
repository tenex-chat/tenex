import { describe, expect, it } from "bun:test";
import {
    formatAnyError,
    formatToolError,
    formatStreamError,
    isMeaningfulAiMessage,
} from "@/lib/error-formatter";

// Local type definition to avoid importing from @/tools (layer violation)
interface ToolError {
	kind: "validation" | "execution" | "system";
	message: string;
	field?: string;
	tool?: string;
}

describe("Error Formatter", () => {
    describe("formatAnyError", () => {
        it("should handle null and undefined", () => {
            expect(formatAnyError(null)).toBe("Unknown error");
            expect(formatAnyError(undefined)).toBe("Unknown error");
        });

        it("should handle string errors", () => {
            expect(formatAnyError("Simple error message")).toBe("Simple error message");
            expect(formatAnyError("")).toBe("");
        });

        it("should handle Error instances", () => {
            const error = new Error("Test error message");
            expect(formatAnyError(error)).toBe("Test error message");
        });

        it("should handle ToolError objects", () => {
            const toolError: ToolError = {
                kind: "validation",
                field: "name",
                message: "Name is required",
                tool: "test-tool",
            };
            expect(formatAnyError(toolError)).toBe("Validation error in name: Name is required");
        });

        it("should handle objects with message property", () => {
            const errorObj = { message: "Custom error message" };
            expect(formatAnyError(errorObj)).toBe("Custom error message");
        });

        it("should handle objects with error properties", () => {
            const errorObj = {
                code: "ENOENT",
                errno: -2,
                syscall: "open",
                path: "/nonexistent",
            };
            expect(formatAnyError(errorObj)).toContain("code: ENOENT");
            expect(formatAnyError(errorObj)).toContain("errno: -2");
            expect(formatAnyError(errorObj)).toContain("syscall: open");
        });

        it("should handle complex objects with JSON stringify", () => {
            const smallObj = { foo: "bar", baz: 123 };
            expect(formatAnyError(smallObj)).toBe(JSON.stringify(smallObj));
        });

        it("should handle large objects gracefully", () => {
            const largeObj: any = {};
            for (let i = 0; i < 100; i++) {
                largeObj[`key${i}`] = `value${i}`;
            }
            expect(formatAnyError(largeObj)).toBe("[Complex Error Object]");
        });

        it("should handle circular references", () => {
            const circular: any = { name: "test" };
            circular.self = circular;
            expect(formatAnyError(circular)).toBe("[Complex Error Object]");
        });

        it("should handle numbers and booleans", () => {
            expect(formatAnyError(42)).toBe("42");
            expect(formatAnyError(true)).toBe("true");
            expect(formatAnyError(false)).toBe("false");
        });
    });

    describe("formatToolError", () => {
        it("should format validation errors with field", () => {
            const error: ToolError = {
                kind: "validation",
                field: "email",
                message: "Invalid email format",
                tool: "user-tool",
            };
            expect(formatToolError(error)).toBe("Validation error in email: Invalid email format");
        });

        it("should format validation errors without field", () => {
            const error: ToolError = {
                kind: "validation",
                field: "",
                message: "Validation failed",
                tool: "test-tool",
            };
            expect(formatToolError(error)).toBe("Validation error: Validation failed");
        });

        it("should handle special case for empty field with 'Required' message", () => {
            const error: ToolError = {
                kind: "validation",
                field: "",
                message: "Required",
                tool: "test-tool",
            };
            expect(formatToolError(error)).toBe("Validation error: Missing required parameter");
        });

        it("should format execution errors with tool", () => {
            const error: ToolError = {
                kind: "execution",
                message: "Command failed",
                tool: "shell",
            };
            expect(formatToolError(error)).toBe("Execution error in shell: Command failed");
        });

        it("should format execution errors without tool", () => {
            const error: ToolError = {
                kind: "execution",
                message: "General execution error",
            };
            expect(formatToolError(error)).toBe("Execution error: General execution error");
        });

        it("should format system errors", () => {
            const error: ToolError = {
                kind: "system",
                message: "Something went wrong",
            };
            expect(formatToolError(error)).toBe("System error: Something went wrong");
        });

        it("should handle unrecognized error kinds", () => {
            const error: any = {
                kind: "custom",
                message: "Custom error message",
            };
            expect(formatToolError(error)).toBe("Custom error message");
        });
    });

    describe("isMeaningfulAiMessage", () => {
        it("should return false for empty or undefined messages", () => {
            expect(isMeaningfulAiMessage(undefined)).toBe(false);
            expect(isMeaningfulAiMessage("")).toBe(false);
            expect(isMeaningfulAiMessage("   ")).toBe(false);
        });

        it("should return false for AI_APICallError messages", () => {
            expect(isMeaningfulAiMessage("AI_APICallError")).toBe(false);
            expect(isMeaningfulAiMessage("AI_APICallError: some details")).toBe(false);
        });

        it("should return false for Provider returned error messages", () => {
            expect(isMeaningfulAiMessage("Provider returned error")).toBe(false);
            expect(isMeaningfulAiMessage("Provider returned error: details")).toBe(false);
        });

        it("should return false for HTTP status code messages", () => {
            expect(isMeaningfulAiMessage("422")).toBe(false);
            expect(isMeaningfulAiMessage("422: Unprocessable Entity")).toBe(false);
            expect(isMeaningfulAiMessage("500 Internal Server Error")).toBe(false);
            expect(isMeaningfulAiMessage("503 Service Unavailable")).toBe(false);
        });

        it("should return false for Unprocessable Entity messages", () => {
            expect(isMeaningfulAiMessage("Unprocessable Entity")).toBe(false);
            expect(isMeaningfulAiMessage("Unprocessable Entity: Invalid request")).toBe(false);
        });

        it("should return false for generic Error: prefix messages", () => {
            expect(isMeaningfulAiMessage("Error:")).toBe(false);
            expect(isMeaningfulAiMessage("Error: something")).toBe(false);
        });

        it("should return true for meaningful error messages", () => {
            expect(isMeaningfulAiMessage("Prompt is too long")).toBe(true);
            expect(isMeaningfulAiMessage("Rate limit exceeded")).toBe(true);
            expect(isMeaningfulAiMessage("Model not available")).toBe(true);
            expect(isMeaningfulAiMessage("Invalid API key")).toBe(true);
            expect(isMeaningfulAiMessage("Context window exceeded")).toBe(true);
        });
    });

    describe("formatStreamError", () => {
        it("should use error.message directly for AI_APICallError with meaningful message", () => {
            // Simulate Claude Code error where error.message contains the useful info
            const error = new Error("Prompt is too long");
            // Override toString to simulate AI_APICallError structure
            error.toString = () => "AI_APICallError: Prompt is too long";

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            expect(result.message).toBe("AI Error: Prompt is too long");
        });

        it("should fall back to regex extraction for errors without meaningful message", () => {
            // Simulate error where message is just the error type
            const error = new Error("AI_APICallError");
            error.toString = () =>
                'AI_APICallError: {"provider_name":"openrouter","raw":"Rate limit exceeded"}';

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            expect(result.message).toContain("openrouter");
            expect(result.message).toContain("Rate limit exceeded");
        });

        it("should fall back to regex extraction for errors with AI_APICallError: prefix in message", () => {
            const error = new Error("AI_APICallError: some details");
            error.toString = () =>
                'AI_APICallError: {"provider_name":"anthropic","raw":"API error"}';

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            expect(result.message).toContain("anthropic");
        });

        // REGRESSION TEST: Generic message should trigger fallback extraction
        it("should fall back to regex when message is 'Provider returned error' but toString has details", () => {
            const error = new Error("Provider returned error");
            error.toString = () =>
                'Provider returned error: {"provider_name":"openai","raw":"Quota exceeded"}';

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            expect(result.message).toContain("openai");
            expect(result.message).toContain("Quota exceeded");
        });

        // REGRESSION TEST: HTTP status in message should trigger fallback extraction
        it("should fall back to regex when message starts with status code but toString has details", () => {
            const error = new Error("422 Unprocessable Entity");
            error.toString = () =>
                '422: {"provider_name":"anthropic","raw":"Content policy violation"}';

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            expect(result.message).toContain("anthropic");
            expect(result.message).toContain("Content policy violation");
        });

        // REGRESSION TEST: "Error:" prefix should trigger fallback
        it("should fall back to regex when message starts with Error: prefix", () => {
            const error = new Error("Error: something went wrong");
            error.toString = () =>
                'AI_APICallError: {"provider_name":"gemini","raw":"Token limit exceeded"}';

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            expect(result.message).toContain("gemini");
            expect(result.message).toContain("Token limit exceeded");
        });

        it("should handle non-AI errors with standard message", () => {
            const error = new Error("Connection timeout");

            const result = formatStreamError(error);
            expect(result.errorType).toBe("system");
            expect(result.message).toBe("Error: Connection timeout");
        });

        it("should handle non-Error objects with default message", () => {
            const result = formatStreamError("string error");
            expect(result.errorType).toBe("system");
            expect(result.message).toBe("An error occurred while processing your request.");
        });

        it("should handle Provider returned error with meaningful message", () => {
            const error = new Error("Model not available");
            error.toString = () => "Provider returned error: Model not available";

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            expect(result.message).toBe("AI Error: Model not available");
        });

        it("should handle 422 status code errors with meaningful message", () => {
            const error = new Error("Invalid request parameters");
            error.toString = () => "422 Unprocessable Entity: Invalid request parameters";

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            expect(result.message).toBe("AI Error: Invalid request parameters");
        });

        it("should handle openrouter errors with meaningful message", () => {
            const error = new Error("Rate limit exceeded");
            error.toString = () => "openrouter: Rate limit exceeded";

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            expect(result.message).toBe("AI Error: Rate limit exceeded");
        });

        it("should use generic fallback when no regex match and no meaningful message", () => {
            const error = new Error("AI_APICallError");
            error.toString = () => "AI_APICallError: no structured data here";

            const result = formatStreamError(error);
            expect(result.errorType).toBe("ai_api");
            // Should fall back to generic since no provider_name found
            expect(result.message).toContain("AI provider");
        });
    });
});
