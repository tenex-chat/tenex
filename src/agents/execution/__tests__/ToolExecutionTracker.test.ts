/**
 * Unit tests for ToolExecutionTracker
 *
 * Tests cover:
 * - Tool execution lifecycle (start → complete)
 * - Error handling and edge cases
 * - State management and queries
 * - Memory management (clearing)
 * - Concurrent execution tracking
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ToolExecutionTracker } from "../ToolExecutionTracker";
import { FullResultStash } from "../ToolOutputTruncation";

// Mock the toolMessageStorage
const mockStore = mock(() => Promise.resolve());

// Mock module exports
mock.module("@/conversations/persistence/ToolMessageStorage", () => ({
    toolMessageStorage: {
        store: mockStore,
    },
}));

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
}));

const BASE_CONVERSATION_ID = "conv-123";

describe("ToolExecutionTracker", () => {
    let tracker: ToolExecutionTracker;

    beforeEach(() => {
        tracker = new ToolExecutionTracker();
        mockStore.mockClear();
    });

    afterEach(() => {
        mockStore.mockClear();
    });

    describe("trackExecution", () => {
        it("should track a new tool execution", () => {
            tracker.trackExecution({
                toolCallId: "call-123",
                toolName: "rag_search",
                args: { query: "test query" },
                conversationId: BASE_CONVERSATION_ID,
            });

            expect(tracker.isTracking("call-123")).toBe(true);

            const execution = tracker.getExecution("call-123");
            expect(execution).toMatchObject({
                toolCallId: "call-123",
                toolName: "rag_search",
                conversationId: BASE_CONVERSATION_ID,
                toolEventId: "",
                input: { query: "test query" },
                completed: false,
            });
        });

        it("should track multiple concurrent executions", () => {
            tracker.trackExecution({
                toolCallId: "call-1",
                toolName: "tool1",
                args: {},
                conversationId: BASE_CONVERSATION_ID,
            });

            tracker.trackExecution({
                toolCallId: "call-2",
                toolName: "tool2",
                args: {},
                conversationId: BASE_CONVERSATION_ID,
            });

            expect(tracker.isTracking("call-1")).toBe(true);
            expect(tracker.isTracking("call-2")).toBe(true);

            const stats = tracker.getStats();
            expect(stats.total).toBe(2);
            expect(stats.pending).toBe(2);
            expect(stats.completed).toBe(0);
        });
    });

    describe("setToolEventId", () => {
        it("should update toolEventId on a tracked execution", () => {
            tracker.trackExecution({
                toolCallId: "call-123",
                toolName: "rag_search",
                args: {},
                conversationId: BASE_CONVERSATION_ID,
            });

            tracker.setToolEventId("call-123", "published-event-id");

            const execution = tracker.getExecution("call-123");
            expect(execution?.toolEventId).toBe("published-event-id");
        });

        it("should silently ignore unknown toolCallId", () => {
            // Should not throw
            tracker.setToolEventId("unknown-id", "some-event-id");
        });
    });

    describe("completeExecution", () => {
        beforeEach(() => {
            tracker.trackExecution({
                toolCallId: "call-123",
                toolName: "rag_search",
                args: { query: "test" },
                conversationId: BASE_CONVERSATION_ID,
            });
            tracker.setToolEventId("call-123", "mock-event-id-123");
        });

        it("should complete a tracked execution and persist it", async () => {
            const result = { results: ["result1", "result2"] };

            const toolEventId = await tracker.completeExecution({
                toolCallId: "call-123",
                result,
                error: false,
                agentPubkey: "agent-pubkey-123",
            });

            expect(toolEventId).toBe("mock-event-id-123");

            const execution = tracker.getExecution("call-123");
            expect(execution).toMatchObject({
                toolCallId: "call-123",
                toolName: "rag_search",
                conversationId: BASE_CONVERSATION_ID,
                toolEventId: "mock-event-id-123",
                input: { query: "test" },
                output: result,
                error: false,
                completed: true,
            });

            expect(mockStore).toHaveBeenCalledWith(
                BASE_CONVERSATION_ID,
                {
                    toolCallId: "call-123",
                    toolName: "rag_search",
                    input: { query: "test" },
                },
                {
                    toolCallId: "call-123",
                    toolName: "rag_search",
                    output: result,
                    error: false,
                },
                "agent-pubkey-123"
            );
        });

        it("should handle error completions", async () => {
            const errorResult = { error: "Tool execution failed" };

            await tracker.completeExecution({
                toolCallId: "call-123",
                result: errorResult,
                error: true,
                agentPubkey: "agent-pubkey-123",
            });

            const execution = tracker.getExecution("call-123");
            expect(execution?.error).toBe(true);
            expect(execution?.completed).toBe(true);
            expect(execution?.output).toEqual(errorResult);
        });

        it("should handle completion of unknown tool call gracefully", async () => {
            await tracker.completeExecution({
                toolCallId: "unknown-call-id",
                result: {},
                error: false,
                agentPubkey: "agent-pubkey-123",
            });

            expect(tracker.getExecution("unknown-call-id")).toBeUndefined();
            expect(mockStore).toHaveBeenCalledTimes(0);
        });

        it("should handle null/undefined results", async () => {
            await tracker.completeExecution({
                toolCallId: "call-123",
                result: null,
                error: false,
                agentPubkey: "agent-pubkey-123",
            });

            const execution = tracker.getExecution("call-123");
            expect(execution?.output).toBeNull();
            expect(execution?.completed).toBe(true);
        });

        it("should return undefined toolEventId when not yet set", async () => {
            tracker.trackExecution({
                toolCallId: "unset-event",
                toolName: "some_tool",
                args: {},
                conversationId: BASE_CONVERSATION_ID,
            });
            // Do NOT call setToolEventId

            const toolEventId = await tracker.completeExecution({
                toolCallId: "unset-event",
                result: {},
                error: false,
                agentPubkey: "agent-pubkey-123",
            });

            // Returns empty string (falsy) when event ID was never set
            expect(toolEventId).toBe("");
        });
    });

    describe("getStats", () => {
        it("should return correct statistics", async () => {
            tracker.trackExecution({ toolCallId: "call-1", toolName: "tool1", args: {}, conversationId: BASE_CONVERSATION_ID });
            tracker.trackExecution({ toolCallId: "call-2", toolName: "tool2", args: {}, conversationId: BASE_CONVERSATION_ID });
            tracker.trackExecution({ toolCallId: "call-3", toolName: "tool3", args: {}, conversationId: BASE_CONVERSATION_ID });

            await tracker.completeExecution({ toolCallId: "call-1", result: { data: "success" }, error: false, agentPubkey: "agent-123" });
            await tracker.completeExecution({ toolCallId: "call-2", result: { error: "failed" }, error: true, agentPubkey: "agent-123" });

            const stats = tracker.getStats();
            expect(stats).toEqual({
                total: 3,
                pending: 1,
                completed: 1,
                failed: 1,
            });
        });

        it("should return zeros for empty tracker", () => {
            const stats = tracker.getStats();
            expect(stats).toEqual({
                total: 0,
                pending: 0,
                completed: 0,
                failed: 0,
            });
        });
    });

    describe("getPendingExecutions", () => {
        it("should return only pending executions", async () => {
            tracker.trackExecution({ toolCallId: "pending-1", toolName: "pendingTool", args: {}, conversationId: BASE_CONVERSATION_ID });
            tracker.trackExecution({ toolCallId: "completed-1", toolName: "completedTool", args: {}, conversationId: BASE_CONVERSATION_ID });

            await tracker.completeExecution({ toolCallId: "completed-1", result: {}, error: false, agentPubkey: "agent-123" });

            const pending = tracker.getPendingExecutions();
            expect(pending).toHaveLength(1);
            expect(pending[0]).toMatchObject({
                toolCallId: "pending-1",
                toolName: "pendingTool",
            });
        });
    });

    describe("getAllExecutions", () => {
        it("should return a copy of all executions", () => {
            tracker.trackExecution({ toolCallId: "call-1", toolName: "tool1", args: {}, conversationId: BASE_CONVERSATION_ID });

            const executions = tracker.getAllExecutions();
            expect(executions.size).toBe(1);

            // Verify it's a copy (modifications don't affect original)
            executions.clear();
            expect(tracker.getAllExecutions().size).toBe(1);
        });
    });

    describe("clear", () => {
        it("should clear all tracked executions", () => {
            tracker.trackExecution({ toolCallId: "call-1", toolName: "tool1", args: {}, conversationId: BASE_CONVERSATION_ID });
            tracker.trackExecution({ toolCallId: "call-2", toolName: "tool2", args: {}, conversationId: BASE_CONVERSATION_ID });

            expect(tracker.getStats().total).toBe(2);

            tracker.clear();

            expect(tracker.getStats().total).toBe(0);
            expect(tracker.isTracking("call-1")).toBe(false);
            expect(tracker.isTracking("call-2")).toBe(false);
        });
    });

    describe("FullResultStash integration", () => {
        it("should persist stashed full result instead of truncated result", async () => {
            const stash = new FullResultStash();
            tracker.setFullResultStash(stash);

            tracker.trackExecution({ toolCallId: "stash-call", toolName: "shell", args: { command: "big output" }, conversationId: BASE_CONVERSATION_ID });

            const fullOutput = "x".repeat(20000);
            stash.stash("stash-call", fullOutput);

            const truncatedPlaceholder = "[shell result truncated...]";

            await tracker.completeExecution({
                toolCallId: "stash-call",
                result: truncatedPlaceholder,
                error: false,
                agentPubkey: "agent-pubkey-123",
            });

            expect(mockStore).toHaveBeenCalledWith(
                BASE_CONVERSATION_ID,
                expect.objectContaining({ toolCallId: "stash-call" }),
                expect.objectContaining({ output: fullOutput }),
                "agent-pubkey-123"
            );
        });

        it("should pass original result when stash has no entry", async () => {
            const stash = new FullResultStash();
            tracker.setFullResultStash(stash);

            tracker.trackExecution({ toolCallId: "no-stash-call", toolName: "small_tool", args: {}, conversationId: BASE_CONVERSATION_ID });

            const smallResult = { data: "small" };

            await tracker.completeExecution({
                toolCallId: "no-stash-call",
                result: smallResult,
                error: false,
                agentPubkey: "agent-pubkey-123",
            });

            expect(mockStore).toHaveBeenCalledWith(
                BASE_CONVERSATION_ID,
                expect.objectContaining({ toolCallId: "no-stash-call" }),
                expect.objectContaining({ output: smallResult }),
                "agent-pubkey-123"
            );
        });

        it("should pass original result when no stash is set", async () => {
            const freshTracker = new ToolExecutionTracker();

            freshTracker.trackExecution({ toolCallId: "no-stash-tracker", toolName: "tool", args: {}, conversationId: BASE_CONVERSATION_ID });

            const result = "some result";

            await freshTracker.completeExecution({
                toolCallId: "no-stash-tracker",
                result,
                error: false,
                agentPubkey: "agent-pubkey-123",
            });

            expect(mockStore).toHaveBeenCalledWith(
                BASE_CONVERSATION_ID,
                expect.objectContaining({ toolCallId: "no-stash-tracker" }),
                expect.objectContaining({ output: result }),
                "agent-pubkey-123"
            );
        });

        it("should clear stash when clear() is called", () => {
            const stash = new FullResultStash();
            tracker.setFullResultStash(stash);
            stash.stash("leftover-call", "leftover data");

            tracker.clear();

            expect(stash.consume("leftover-call")).toBeUndefined();
        });
    });

    describe("Edge cases and error scenarios", () => {
        it("should handle tool execution with very large arguments", () => {
            const largeArgs = {
                data: Array(1000).fill("x").join(""),
                nested: { deep: { structure: { with: { lots: { of: { levels: "value" } } } } } },
            };

            tracker.trackExecution({ toolCallId: "large-args", toolName: "bigTool", args: largeArgs, conversationId: BASE_CONVERSATION_ID });

            const execution = tracker.getExecution("large-args");
            expect(execution?.input).toEqual(largeArgs);
        });

        it("should handle rapid successive completions", async () => {
            for (let i = 0; i < 10; i++) {
                tracker.trackExecution({ toolCallId: `rapid-${i}`, toolName: `tool${i}`, args: { index: i }, conversationId: BASE_CONVERSATION_ID });
            }

            await Promise.all(
                Array.from({ length: 10 }, (_, i) =>
                    tracker.completeExecution({ toolCallId: `rapid-${i}`, result: { completed: i }, error: false, agentPubkey: "agent-123" })
                )
            );

            const stats = tracker.getStats();
            expect(stats.completed).toBe(10);
            expect(stats.pending).toBe(0);
        });

        it("should handle storage errors during completion", async () => {
            tracker.trackExecution({ toolCallId: "storage-fail", toolName: "tool", args: {}, conversationId: BASE_CONVERSATION_ID });

            mockStore.mockImplementation(() => Promise.reject(new Error("Storage error")));

            await expect(
                tracker.completeExecution({ toolCallId: "storage-fail", result: {}, error: false, agentPubkey: "agent-123" })
            ).rejects.toThrow("Storage error");

            const execution = tracker.getExecution("storage-fail");
            expect(execution?.completed).toBe(true);
        });
    });
});
