import { describe, it, expect } from "bun:test";
import {
    serializeToolResult,
    isSerializedToolResult,
    deserializeToolResult,
    type SerializedToolResult,
} from "../ToolResult";
import type { ToolExecutionResult } from "@/tools/types";

describe("ToolResult", () => {
    describe("serializeToolResult", () => {
        it("should serialize successful result", () => {
            const result: ToolExecutionResult = {
                success: true,
                duration: 100,
                output: { data: "test output" },
            };

            const serialized = serializeToolResult(result);

            expect(serialized).toEqual({
                success: true,
                duration: 100,
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
                error: {
                    kind: "system",
                    message: "System error occurred",
                },
            };

            const serialized = serializeToolResult(result);

            expect(serialized).toEqual({
                success: false,
                duration: 10,
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
                data: {},
            };

            expect(isSerializedToolResult(obj)).toBe(false);
        });

        it("should return false for missing duration field", () => {
            const obj = {
                success: true,
                data: {},
            };

            expect(isSerializedToolResult(obj)).toBe(false);
        });

        it("should return false for missing data field", () => {
            const obj = {
                success: true,
                duration: 100,
            };

            expect(isSerializedToolResult(obj)).toBe(false);
        });

        it("should return false for wrong success type", () => {
            const obj = {
                success: "true",
                duration: 100,
                data: {},
            };

            expect(isSerializedToolResult(obj)).toBe(false);
        });

        it("should return false for wrong duration type", () => {
            const obj = {
                success: true,
                duration: "100",
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
                data: {
                    output: { data: "test" },
                },
            };

            const result = deserializeToolResult(serialized);

            expect(result).toEqual({
                success: true,
                duration: 100,
                output: { data: "test" },
                error: undefined,
            });
        });

        it("should deserialize validation error", () => {
            const serialized: SerializedToolResult = {
                success: false,
                duration: 50,
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
                output: undefined,
                error: {
                    kind: "system",
                    message: "Unknown error",
                },
            });
        });
    });
});