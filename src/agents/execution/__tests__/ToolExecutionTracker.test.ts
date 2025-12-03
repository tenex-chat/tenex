/**
 * Unit tests for ToolExecutionTracker
 *
 * Tests cover:
 * - Tool execution lifecycle (start → complete)
 * - Error handling and edge cases
 * - State management and queries
 * - Human-readable content generation
 * - Memory management (clearing)
 * - Concurrent execution tracking
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Tool as CoreTool } from "ai";
import { ToolExecutionTracker } from "../ToolExecutionTracker";

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

describe("ToolExecutionTracker", () => {
    let tracker: ToolExecutionTracker;
    let mockAgentPublisher: AgentPublisher;
    let mockEventContext: EventContext;
    let mockToolsObject: Record<string, CoreTool>;

    beforeEach(() => {
        tracker = new ToolExecutionTracker();

        // Create mock AgentPublisher
        mockAgentPublisher = {
            toolUse: mock(() =>
                Promise.resolve({
                    id: "mock-event-id-123",
                    content: "Mock tool event",
                    pubkey: "mock-pubkey",
                } as NDKEvent)
            ),
        } as any;

        // Create mock EventContext
        mockEventContext = {
            triggeringEvent: { id: "trigger-123" } as NDKEvent,
            rootEvent: { id: "root-123" } as NDKEvent,
            conversationId: "conv-123",
            model: "test:test-model",
        };

        // Create mock tools object
        mockToolsObject = {
            search: {
                getHumanReadableContent: mock(() => 'Searching for "test query"'),
            } as any,
            calculator: {} as any, // Tool without getHumanReadableContent
            mcp__github__create_issue: {} as any, // MCP tool
        };

        // Clear all mocks
        mockStore.mockClear();
        mockAgentPublisher.toolUse.mockClear();
        if (mockToolsObject.search?.getHumanReadableContent) {
            mockToolsObject.search.getHumanReadableContent.mockClear();
        }
    });

    afterEach(() => {
        mockStore.mockClear();
    });

    describe("trackExecution", () => {
        it("should track a new tool execution successfully", async () => {
            await tracker.trackExecution({
                toolCallId: "call-123",
                toolName: "search",
                args: { query: "test query" },
                toolsObject: mockToolsObject,
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                {
                    toolName: "search",
                    content: 'Searching for "test query"',
                    args: { query: "test query" },
                },
                mockEventContext
            );

            expect(tracker.isTracking("call-123")).toBe(true);

            const execution = tracker.getExecution("call-123");
            expect(execution).toEqual({
                toolCallId: "call-123",
                toolName: "search",
                toolEventId: "mock-event-id-123",
                input: { query: "test query" },
                completed: false,
            });
        });

        it("should use default human-readable content for tools without custom formatter", async () => {
            await tracker.trackExecution({
                toolCallId: "call-456",
                toolName: "calculator",
                args: { operation: "add", a: 1, b: 2 },
                toolsObject: mockToolsObject,
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: "Executing calculator",
                }),
                mockEventContext
            );
        });

        it("should format MCP tool names correctly", async () => {
            await tracker.trackExecution({
                toolCallId: "call-789",
                toolName: "mcp__github__create_issue",
                args: { title: "Test issue" },
                toolsObject: mockToolsObject,
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: "Executing github's create issue",
                }),
                mockEventContext
            );
        });

        it("should track multiple concurrent executions", async () => {
            await tracker.trackExecution({
                toolCallId: "call-1",
                toolName: "tool1",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            await tracker.trackExecution({
                toolCallId: "call-2",
                toolName: "tool2",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(tracker.isTracking("call-1")).toBe(true);
            expect(tracker.isTracking("call-2")).toBe(true);

            const stats = tracker.getStats();
            expect(stats.total).toBe(2);
            expect(stats.pending).toBe(2);
            expect(stats.completed).toBe(0);
        });
    });

    describe("completeExecution", () => {
        beforeEach(async () => {
            // Setup: Track an execution first
            await tracker.trackExecution({
                toolCallId: "call-123",
                toolName: "search",
                args: { query: "test" },
                toolsObject: mockToolsObject,
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });
        });

        it("should complete a tracked execution successfully", async () => {
            const result = { results: ["result1", "result2"] };

            await tracker.completeExecution({
                toolCallId: "call-123",
                result,
                error: false,
                agentPubkey: "agent-pubkey-123",
            });

            const execution = tracker.getExecution("call-123");
            expect(execution).toEqual({
                toolCallId: "call-123",
                toolName: "search",
                toolEventId: "mock-event-id-123",
                input: { query: "test" },
                output: result,
                error: false,
                completed: true,
            });

            // Verify filesystem persistence
            expect(mockStore).toHaveBeenCalledWith(
                "mock-event-id-123",
                {
                    toolCallId: "call-123",
                    toolName: "search",
                    input: { query: "test" },
                },
                {
                    toolCallId: "call-123",
                    toolName: "search",
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

            // Should not throw, just log warning
            expect(tracker.getExecution("unknown-call-id")).toBeUndefined();

            // Storage should not be called for unknown executions
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
    });

    describe("getStats", () => {
        it("should return correct statistics", async () => {
            // Track 3 executions
            await tracker.trackExecution({
                toolCallId: "call-1",
                toolName: "tool1",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            await tracker.trackExecution({
                toolCallId: "call-2",
                toolName: "tool2",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            await tracker.trackExecution({
                toolCallId: "call-3",
                toolName: "tool3",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Complete one successfully
            await tracker.completeExecution({
                toolCallId: "call-1",
                result: { data: "success" },
                error: false,
                agentPubkey: "agent-123",
            });

            // Complete one with error
            await tracker.completeExecution({
                toolCallId: "call-2",
                result: { error: "failed" },
                error: true,
                agentPubkey: "agent-123",
            });

            // Leave one pending

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
            // Track 2 executions
            await tracker.trackExecution({
                toolCallId: "pending-1",
                toolName: "pendingTool",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            await tracker.trackExecution({
                toolCallId: "completed-1",
                toolName: "completedTool",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Complete one
            await tracker.completeExecution({
                toolCallId: "completed-1",
                result: {},
                error: false,
                agentPubkey: "agent-123",
            });

            const pending = tracker.getPendingExecutions();
            expect(pending).toHaveLength(1);
            expect(pending[0]).toEqual({
                toolCallId: "pending-1",
                toolName: "pendingTool",
                startedAt: "mock-eve", // First 8 chars of event ID
            });
        });
    });

    describe("getAllExecutions", () => {
        it("should return a copy of all executions", async () => {
            await tracker.trackExecution({
                toolCallId: "call-1",
                toolName: "tool1",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            const executions = tracker.getAllExecutions();
            expect(executions.size).toBe(1);

            // Verify it's a copy (modifications don't affect original)
            executions.clear();
            expect(tracker.getAllExecutions().size).toBe(1);
        });
    });

    describe("clear", () => {
        it("should clear all tracked executions", async () => {
            // Track multiple executions
            await tracker.trackExecution({
                toolCallId: "call-1",
                toolName: "tool1",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            await tracker.trackExecution({
                toolCallId: "call-2",
                toolName: "tool2",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(tracker.getStats().total).toBe(2);

            tracker.clear();

            expect(tracker.getStats().total).toBe(0);
            expect(tracker.isTracking("call-1")).toBe(false);
            expect(tracker.isTracking("call-2")).toBe(false);
        });
    });

    describe("Edge cases and error scenarios", () => {
        it("should handle MCP tools with incorrect format", async () => {
            await tracker.trackExecution({
                toolCallId: "mcp-edge",
                toolName: "mcp__invalid", // Invalid MCP format (only 2 parts)
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: "Executing mcp__invalid", // Should fall back to original
                }),
                mockEventContext
            );
        });

        it("should handle tool execution with very large arguments", async () => {
            const largeArgs = {
                data: Array(1000).fill("x").join(""), // Large string
                nested: {
                    deep: {
                        structure: {
                            with: {
                                lots: {
                                    of: {
                                        levels: "value",
                                    },
                                },
                            },
                        },
                    },
                },
            };

            await tracker.trackExecution({
                toolCallId: "large-args",
                toolName: "bigTool",
                args: largeArgs,
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            const execution = tracker.getExecution("large-args");
            expect(execution?.input).toEqual(largeArgs);
        });

        it("should handle rapid successive completions", async () => {
            // Track multiple executions
            const promises = [];
            for (let i = 0; i < 10; i++) {
                promises.push(
                    tracker.trackExecution({
                        toolCallId: `rapid-${i}`,
                        toolName: `tool${i}`,
                        args: { index: i },
                        toolsObject: {},
                        agentPublisher: mockAgentPublisher,
                        eventContext: mockEventContext,
                    })
                );
            }

            await Promise.all(promises);

            // Complete them all rapidly
            const completionPromises = [];
            for (let i = 0; i < 10; i++) {
                completionPromises.push(
                    tracker.completeExecution({
                        toolCallId: `rapid-${i}`,
                        result: { completed: i },
                        error: false,
                        agentPubkey: "agent-123",
                    })
                );
            }

            await Promise.all(completionPromises);

            const stats = tracker.getStats();
            expect(stats.completed).toBe(10);
            expect(stats.pending).toBe(0);
        });

        it("should handle publisher throwing errors gracefully", async () => {
            const failingPublisher = {
                toolUse: mock(() => Promise.reject(new Error("Network error"))),
            } as any;

            await expect(
                tracker.trackExecution({
                    toolCallId: "will-fail",
                    toolName: "failTool",
                    args: {},
                    toolsObject: {},
                    agentPublisher: failingPublisher,
                    eventContext: mockEventContext,
                })
            ).rejects.toThrow("Network error");

            // Execution is tracked even if publishing failed (to prevent race conditions)
            // The execution just won't have a valid toolEventId
            expect(tracker.isTracking("will-fail")).toBe(true);
            const execution = tracker.getExecution("will-fail");
            expect(execution?.toolEventId).toBe(""); // Empty because publish failed
        });

        it("should handle storage errors during completion", async () => {
            // Track execution first
            await tracker.trackExecution({
                toolCallId: "storage-fail",
                toolName: "tool",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Mock storage to throw
            mockStore.mockImplementation(() => Promise.reject(new Error("Storage error")));

            await expect(
                tracker.completeExecution({
                    toolCallId: "storage-fail",
                    result: {},
                    error: false,
                    agentPubkey: "agent-123",
                })
            ).rejects.toThrow("Storage error");

            // Execution should still be marked as completed despite storage error
            const execution = tracker.getExecution("storage-fail");
            expect(execution?.completed).toBe(true);
        });
    });
});
