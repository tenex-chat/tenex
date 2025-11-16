import { describe, expect, it } from "bun:test";
import type { ToolExecutionResult } from "@/tools/types";
import {
    type SerializedToolResult,
    deserializeToolResult,
    isSerializedToolResult,
    serializeToolResult,
} from "../ToolResult";

describe("ToolResult", () => {
    describe("serializeToolResult", () => {
        it("should serialize successful result", () => {
            const result: ToolExecutionResult = {
                success: true,
                duration: 100,
                toolName: "test_tool",
                toolArgs: { arg1: "value1" },
                output: { data: "test output" },
            };

            const serialized = serializeToolResult(result);

            expect(serialized).toEqual({
                success: true,
                duration: 100,
                toolName: "test_tool",
                toolArgs: { arg1: "value1" },
                data: {
                    output: { data: "test output" },
                    error: undefined,
                },
            });
        });

        it("should serialize failed result with validation error", () => {
            const result: ToolExecutionResult = {
                success: false,
                duration: 50,
                toolName: "test_tool",
                toolArgs: { input: "invalid" },
                error: {
                    kind: "validation",
                    field: "input",
                    message: "Invalid input",
                },
            };

            const serialized = serializeToolResult(result);

            expect(serialized).toEqual({
                success: false,
                duration: 50,
                toolName: "test_tool",
                toolArgs: { input: "invalid" },
                data: {
                    output: undefined,
                    error: {
                        kind: "validation",
                        message: "Invalid input",
                    },
                },
            });
        });

        it("should serialize failed result with execution error", () => {
            const result: ToolExecutionResult = {
                success: false,
                duration: 200,
                toolName: "testTool",
                toolArgs: { cmd: "run" },
                error: {
                    kind: "execution",
                    tool: "testTool",
                    message: "Tool execution failed",
                },
            };

            const serialized = serializeToolResult(result);

            expect(serialized).toEqual({
                success: false,
                duration: 200,
                toolName: "testTool",
                toolArgs: { cmd: "run" },
                data: {
                    output: undefined,
                    error: {
                        kind: "execution",
                        message: "Tool execution failed",
                    },
                },
            });
        });

        it("should serialize failed result with system error", () => {
            const result: ToolExecutionResult = {
                success: false,
                duration: 10,
                toolName: "system_tool",
                toolArgs: {},
                error: {
                    kind: "system",
                    message: "System error occurred",
                },
            };

            const serialized = serializeToolResult(result);

            expect(serialized).toEqual({
                success: false,
                duration: 10,
                toolName: "system_tool",
                toolArgs: {},
                data: {
                    output: undefined,
                    error: {
                        kind: "system",
                        message: "System error occurred",
                    },
                },
            });
        });
    });

    describe("isSerializedToolResult", () => {
        it("should return true for valid serialized result", () => {
            const obj: SerializedToolResult = {
                success: true,
                duration: 100,
                toolName: "test_tool",
                toolArgs: { arg1: "value1" },
                data: {
                    output: "test",
                },
            };

            expect(isSerializedToolResult(obj)).toBe(true);
        });

        it("should return false for null", () => {
            expect(isSerializedToolResult(null)).toBe(false);
        });

        it("should return false for undefined", () => {
            expect(isSerializedToolResult(undefined)).toBe(false);
        });

        it("should return false for missing success field", () => {
            const obj = {
                duration: 100,
                toolName: "test",
                toolArgs: {},
                data: {},
            };

            expect(isSerializedToolResult(obj)).toBe(false);
        });

        it("should return false for missing duration field", () => {
            const obj = {
                success: true,
                toolName: "test",
                toolArgs: {},
                data: {},
            };

            expect(isSerializedToolResult(obj)).toBe(false);
        });

        it("should return false for missing data field", () => {
            const obj = {
                success: true,
                duration: 100,
                toolName: "test",
                toolArgs: {},
            };

            expect(isSerializedToolResult(obj)).toBe(false);
        });

        it("should return false for wrong success type", () => {
            const obj = {
                success: "true",
                duration: 100,
                toolName: "test",
                toolArgs: {},
                data: {},
            };

            expect(isSerializedToolResult(obj)).toBe(false);
        });

        it("should return false for wrong duration type", () => {
            const obj = {
                success: true,
                duration: "100",
                toolName: "test",
                toolArgs: {},
                data: {},
            };

            expect(isSerializedToolResult(obj)).toBe(false);
        });
    });

    describe("deserializeToolResult", () => {
        it("should deserialize successful result", () => {
            const serialized: SerializedToolResult = {
                success: true,
                duration: 100,
                toolName: "test_tool",
                toolArgs: { arg1: "value1" },
                data: {
                    output: { data: "test" },
                },
            };

            const result = deserializeToolResult(serialized);

            expect(result).toEqual({
                success: true,
                duration: 100,
                toolName: "test_tool",
                toolArgs: { arg1: "value1" },
                output: { data: "test" },
                error: undefined,
            });
        });

        it("should deserialize validation error", () => {
            const serialized: SerializedToolResult = {
                success: false,
                duration: 50,
                toolName: "test_tool",
                toolArgs: { input: "invalid" },
                data: {
                    error: {
                        kind: "validation",
                        message: "Invalid input",
                    },
                },
            };

            const result = deserializeToolResult(serialized);

            expect(result).toEqual({
                success: false,
                duration: 50,
                toolName: "test_tool",
                toolArgs: { input: "invalid" },
                output: undefined,
                error: {
                    kind: "validation",
                    field: "unknown",
                    message: "Invalid input",
                },
            });
        });

        it("should deserialize execution error", () => {
            const serialized: SerializedToolResult = {
                success: false,
                duration: 200,
                toolName: "testTool",
                toolArgs: { cmd: "run" },
                data: {
                    error: {
                        kind: "execution",
                        message: "Tool failed",
                    },
                },
            };

            const result = deserializeToolResult(serialized);

            expect(result).toEqual({
                success: false,
                duration: 200,
                toolName: "testTool",
                toolArgs: { cmd: "run" },
                output: undefined,
                error: {
                    kind: "execution",
                    tool: "unknown",
                    message: "Tool failed",
                },
            });
        });

        it("should deserialize system error", () => {
            const serialized: SerializedToolResult = {
                success: false,
                duration: 10,
                toolName: "system_tool",
                toolArgs: {},
                data: {
                    error: {
                        kind: "system",
                        message: "System error",
                    },
                },
            };

            const result = deserializeToolResult(serialized);

            expect(result).toEqual({
                success: false,
                duration: 10,
                toolName: "system_tool",
                toolArgs: {},
                output: undefined,
                error: {
                    kind: "system",
                    message: "System error",
                },
            });
        });

        it("should handle unknown error kind as system error", () => {
            const serialized: SerializedToolResult = {
                success: false,
                duration: 15,
                toolName: "unknown_tool",
                toolArgs: { test: true },
                data: {
                    error: {
                        kind: "unknown",
                        message: "Unknown error",
                    },
                },
            };

            const result = deserializeToolResult(serialized);

            expect(result).toEqual({
                success: false,
                duration: 15,
                toolName: "unknown_tool",
                toolArgs: { test: true },
                output: undefined,
                error: {
                    kind: "system",
                    message: "Unknown error",
                },
            });
        });
    });
});
