import { describe, expect, it } from "bun:test";
import type { ToolResultPart } from "ai";
import {
    shouldTruncateToolResult,
    createTruncatedToolResult,
    processToolResult,
    type TruncationContext,
} from "../tool-result-truncator";

describe("tool-result-truncator", () => {
    // Helper to create a tool result with specified size
    const createToolResult = (size: number, toolCallId = "test-call-id"): ToolResultPart[] => [{
        type: "tool-result" as const,
        toolCallId,
        toolName: "test-tool",
        output: {
            type: "text" as const,
            value: "x".repeat(size),
        },
    }];

    describe("shouldTruncateToolResult", () => {
        it("should never truncate results under 1k chars regardless of burial depth", () => {
            const toolData = createToolResult(500); // 500 chars, under 1k threshold
            const context: TruncationContext = {
                currentIndex: 0,
                totalMessages: 100, // Deeply buried
                eventId: "test-event-id",
            };

            expect(shouldTruncateToolResult(toolData, context)).toBe(false);
        });

        it("should not truncate without eventId", () => {
            const toolData = createToolResult(15000); // Large result
            const context: TruncationContext = {
                currentIndex: 0,
                totalMessages: 100, // Deeply buried
                // No eventId
            };

            expect(shouldTruncateToolResult(toolData, context)).toBe(false);
        });

        it("should not truncate small results (1k-10k) that are recent", () => {
            const toolData = createToolResult(5000); // 5k chars
            const context: TruncationContext = {
                currentIndex: 97,
                totalMessages: 100, // Only 2 messages buried (< 6)
                eventId: "test-event-id",
            };

            expect(shouldTruncateToolResult(toolData, context)).toBe(false);
        });

        it("should truncate small results (1k-10k) buried by 6+ messages", () => {
            const toolData = createToolResult(5000); // 5k chars
            const context: TruncationContext = {
                currentIndex: 90,
                totalMessages: 100, // 9 messages buried (>= 6)
                eventId: "test-event-id",
            };

            expect(shouldTruncateToolResult(toolData, context)).toBe(true);
        });

        it("should not truncate large results that are very recent", () => {
            const toolData = createToolResult(15000); // 15k chars, over threshold
            const context: TruncationContext = {
                currentIndex: 98,
                totalMessages: 100, // Only 1 message buried (< 3)
                eventId: "test-event-id",
            };

            expect(shouldTruncateToolResult(toolData, context)).toBe(false);
        });

        it("should truncate large results buried by 3+ messages", () => {
            const toolData = createToolResult(15000); // 15k chars
            const context: TruncationContext = {
                currentIndex: 95,
                totalMessages: 100, // 4 messages buried (>= 3)
                eventId: "test-event-id",
            };

            expect(shouldTruncateToolResult(toolData, context)).toBe(true);
        });

        it("should handle edge case exactly at small burial limit", () => {
            const toolData = createToolResult(5000);
            const context: TruncationContext = {
                currentIndex: 94,
                totalMessages: 100, // Exactly 5 messages buried (< 6)
                eventId: "test-event-id",
            };

            expect(shouldTruncateToolResult(toolData, context)).toBe(false);
        });

        it("should handle edge case exactly at large burial limit", () => {
            const toolData = createToolResult(15000);
            const context: TruncationContext = {
                currentIndex: 97,
                totalMessages: 100, // Exactly 2 messages buried (< 3)
                eventId: "test-event-id",
            };

            expect(shouldTruncateToolResult(toolData, context)).toBe(false);
        });
    });

    describe("createTruncatedToolResult", () => {
        it("should create truncated result with event ID reference", () => {
            const toolData = createToolResult(5000, "my-tool-call-123");
            const eventId = "abc123def456";
            const truncated = createTruncatedToolResult(toolData, eventId);

            expect(truncated).toHaveLength(1);
            expect(truncated[0].toolCallId).toBe("my-tool-call-123");
            expect(truncated[0].toolName).toBe("test-tool");
            expect(truncated[0].output).toEqual({
                type: "text",
                value: expect.stringContaining("5000 chars output truncated"),
            });
            expect(truncated[0].output).toEqual({
                type: "text",
                value: expect.stringContaining(`fs_read(tool="${eventId}")`),
            });
        });

        it("should preserve tool metadata in truncated result", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "specific-id",
                toolName: "specific-tool",
                output: { type: "text", value: "content" },
            }];
            const truncated = createTruncatedToolResult(toolData, "event-123");

            expect(truncated[0].type).toBe("tool-result");
            expect(truncated[0].toolCallId).toBe("specific-id");
            expect(truncated[0].toolName).toBe("specific-tool");
        });
    });

    describe("processToolResult", () => {
        it("should return original data when not buried deep enough", () => {
            const toolData = createToolResult(5000);
            const context: TruncationContext = {
                currentIndex: 99,
                totalMessages: 100,
                eventId: "test-event-id",
            };

            const result = processToolResult(toolData, context);
            expect(result).toBe(toolData); // Same reference
        });

        it("should return original data when no eventId provided", () => {
            const toolData = createToolResult(15000);
            const context: TruncationContext = {
                currentIndex: 0,
                totalMessages: 100, // Deeply buried
                // No eventId
            };

            const result = processToolResult(toolData, context);
            expect(result).toBe(toolData); // Same reference, not truncated
        });

        it("should return truncated data when buried deep enough with eventId", () => {
            const toolData = createToolResult(15000);
            const context: TruncationContext = {
                currentIndex: 90,
                totalMessages: 100,
                eventId: "test-event-id",
            };

            const result = processToolResult(toolData, context);
            expect(result).not.toBe(toolData);
            expect(result[0].output).toEqual({
                type: "text",
                value: expect.stringContaining("truncated"),
            });
            expect(result[0].output).toEqual({
                type: "text",
                value: expect.stringContaining("test-event-id"),
            });
        });

        it("should handle multiple tool results in array", () => {
            const toolData: ToolResultPart[] = [
                {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "tool-1",
                    output: { type: "text", value: "x".repeat(8000) },
                },
                {
                    type: "tool-result",
                    toolCallId: "call-2",
                    toolName: "tool-2",
                    output: { type: "text", value: "y".repeat(8000) },
                },
            ];
            const context: TruncationContext = {
                currentIndex: 90,
                totalMessages: 100,
                eventId: "test-event-id",
            };

            const result = processToolResult(toolData, context);
            expect(result).toHaveLength(2);
            expect(result[0].toolCallId).toBe("call-1");
            expect(result[1].toolCallId).toBe("call-2");
        });
    });
});
