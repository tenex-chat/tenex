import { describe, expect, it } from "bun:test";
import { formatAnyError, formatToolError } from "@/lib/error-formatter";

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
});
