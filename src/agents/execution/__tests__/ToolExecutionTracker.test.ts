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
import type { EventContext } from "@/nostr/types";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import { PendingDelegationsRegistry } from "@/services/ral";
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
            rag_search: {
                getHumanReadableContent: mock(() => 'Searching for "test query"'),
            } as any,
            calculator: {} as any, // Tool without getHumanReadableContent
            mcp__github__create_issue: {} as any, // MCP tool
        };

        // Clear all mocks
        mockStore.mockClear();
        mockAgentPublisher.toolUse.mockClear();
        if (mockToolsObject.rag_search?.getHumanReadableContent) {
            mockToolsObject.rag_search.getHumanReadableContent.mockClear();
        }
    });

    afterEach(() => {
        mockStore.mockClear();
        PendingDelegationsRegistry.clear();
    });

    describe("trackExecution", () => {
        it("should track a new tool execution successfully", async () => {
            await tracker.trackExecution({
                toolCallId: "call-123",
                toolName: "rag_search",
                args: { query: "test query" },
                toolsObject: mockToolsObject,
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                {
                    toolName: "rag_search",
                    content: 'Searching for "test query"',
                    args: { query: "test query" },
                },
                mockEventContext
            );

            expect(tracker.isTracking("call-123")).toBe(true);

            const execution = tracker.getExecution("call-123");
            expect(execution).toEqual({
                toolCallId: "call-123",
                toolName: "rag_search",
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

        it("should return the published NDKEvent", async () => {
            const returnedEvent = await tracker.trackExecution({
                toolCallId: "call-return-event",
                toolName: "rag_search",
                args: { query: "test" },
                toolsObject: mockToolsObject,
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(returnedEvent).toBeDefined();
            expect(returnedEvent.id).toBe("mock-event-id-123");
            expect(returnedEvent.pubkey).toBe("mock-pubkey");
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
                toolName: "rag_search",
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
                toolName: "rag_search",
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

    describe("Delegation tool delayed publishing", () => {
        it("should return null and not publish for delegate tool", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "delegate-call",
                toolName: "delegate",
                args: { delegations: [{ recipient: "agent1", prompt: "Do X" }] },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Should return null for delegation tools
            expect(result).toBeNull();

            // Should NOT have published yet
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();

            // Should still be tracking
            expect(tracker.isTracking("delegate-call")).toBe(true);

            // Should have empty toolEventId
            const execution = tracker.getExecution("delegate-call");
            expect(execution?.toolEventId).toBe("");
        });

        it("should return null for ask tool", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "ask-call",
                toolName: "ask",
                args: { content: "What should I do?" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(result).toBeNull();
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();
        });

        it("should return null for delegate_followup tool", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "followup-call",
                toolName: "delegate_followup",
                args: { message: "Continue with this" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(result).toBeNull();
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();
        });

        it("should return null for delegate_crossproject tool", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "crossproject-call",
                toolName: "delegate_crossproject",
                args: { content: "Cross-project task", projectId: "test-project", agentSlug: "target-agent" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(result).toBeNull();
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();
        });

        it("should publish with referenced event IDs on completion", async () => {
            // Track delegation tool
            await tracker.trackExecution({
                toolCallId: "delegate-complete",
                toolName: "delegate",
                args: { delegations: [{ recipient: "agent1", prompt: "Do X" }] },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Register with PendingDelegationsRegistry (simulates what AgentPublisher.delegate() does)
            PendingDelegationsRegistry.register("agent-pubkey", mockEventContext.conversationId, "delegation-event-123");

            // Simulate result with pendingDelegations from delegate tool
            const delegationResult = {
                __stopExecution: true,
                pendingDelegations: [
                    { delegationConversationId: "delegation-event-123", recipientPubkey: "pubkey1", prompt: "Do X" },
                ],
                delegationEventIds: { pubkey1: "delegation-event-123" },
                message: "Delegated",
            };

            await tracker.completeExecution({
                toolCallId: "delegate-complete",
                result: delegationResult,
                error: false,
                agentPubkey: "agent-pubkey",
            });

            // Should have published with referencedEventIds from registry
            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    toolName: "delegate",
                    referencedEventIds: ["delegation-event-123"],
                }),
                mockEventContext
            );

            // toolEventId should be updated
            const execution = tracker.getExecution("delegate-complete");
            expect(execution?.toolEventId).toBe("mock-event-id-123");
        });

        it("should include multiple event IDs for multi-delegation", async () => {
            await tracker.trackExecution({
                toolCallId: "multi-delegate",
                toolName: "delegate",
                args: { delegations: [{ recipient: "agent1" }, { recipient: "agent2" }] },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Register with PendingDelegationsRegistry (simulates what AgentPublisher.delegate() does)
            PendingDelegationsRegistry.register("agent-pubkey", mockEventContext.conversationId, "delegation-1");
            PendingDelegationsRegistry.register("agent-pubkey", mockEventContext.conversationId, "delegation-2");

            const delegationResult = {
                __stopExecution: true,
                pendingDelegations: [
                    { delegationConversationId: "delegation-1", recipientPubkey: "pubkey1", prompt: "Task 1" },
                    { delegationConversationId: "delegation-2", recipientPubkey: "pubkey2", prompt: "Task 2" },
                ],
                delegationEventIds: { pubkey1: "delegation-1", pubkey2: "delegation-2" },
                message: "Delegated",
            };

            await tracker.completeExecution({
                toolCallId: "multi-delegate",
                result: delegationResult,
                error: false,
                agentPubkey: "agent-pubkey",
            });

            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    referencedEventIds: ["delegation-1", "delegation-2"],
                }),
                mockEventContext
            );
        });

        it("should handle missing pendingDelegations gracefully", async () => {
            await tracker.trackExecution({
                toolCallId: "no-pending",
                toolName: "delegate",
                args: {},
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Result without pendingDelegations
            await tracker.completeExecution({
                toolCallId: "no-pending",
                result: { __stopExecution: true },
                error: false,
                agentPubkey: "agent-pubkey",
            });

            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    referencedEventIds: [],
                }),
                mockEventContext
            );
        });

        it("should not affect non-delegation tools", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "normal-tool",
                toolName: "rag_search",
                args: { query: "test" },
                toolsObject: mockToolsObject,
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Should return the event (not null)
            expect(result).not.toBeNull();
            expect(result?.id).toBe("mock-event-id-123");

            // Should have published immediately
            expect(mockAgentPublisher.toolUse).toHaveBeenCalled();

            // toolEventId should be set immediately
            const execution = tracker.getExecution("normal-tool");
            expect(execution?.toolEventId).toBe("mock-event-id-123");
        });

        it("should return null for MCP-wrapped delegate tool (mcp__tenex__delegate)", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "mcp-delegate-call",
                toolName: "mcp__tenex__delegate",
                args: { delegations: [{ recipient: "agent1", prompt: "Do X" }] },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Should return null for MCP-wrapped delegation tools
            expect(result).toBeNull();

            // Should NOT have published yet
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();

            // Should still be tracking
            expect(tracker.isTracking("mcp-delegate-call")).toBe(true);

            // Should have empty toolEventId
            const execution = tracker.getExecution("mcp-delegate-call");
            expect(execution?.toolEventId).toBe("");
        });

        it("should return null for MCP-wrapped ask tool (mcp__tenex__ask)", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "mcp-ask-call",
                toolName: "mcp__tenex__ask",
                args: { content: "Question?" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(result).toBeNull();
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();
        });

        it("should return null for MCP-wrapped delegate_followup tool", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "mcp-followup-call",
                toolName: "mcp__tenex__delegate_followup",
                args: { message: "Continue" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(result).toBeNull();
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();
        });

        it("should return null for MCP-wrapped delegate_crossproject tool", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "mcp-crossproject-call",
                toolName: "mcp__tenex__delegate_crossproject",
                args: { content: "Cross-project", projectId: "proj", agentSlug: "agent" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            expect(result).toBeNull();
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();
        });

        it("should publish with referenced event IDs on completion for MCP-wrapped delegate", async () => {
            // Track MCP-wrapped delegation tool
            await tracker.trackExecution({
                toolCallId: "mcp-delegate-complete",
                toolName: "mcp__tenex__delegate",
                args: { delegations: [{ recipient: "agent1", prompt: "Do X" }] },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Register with PendingDelegationsRegistry (simulates what AgentPublisher.delegate() does)
            // This is the key fix: MCP result transformation strips pendingDelegations,
            // but we now get event IDs from the registry which was populated at publish time
            PendingDelegationsRegistry.register("agent-pubkey", mockEventContext.conversationId, "mcp-delegation-event-123");

            // Simulate MCP-transformed result (Claude Code SDK strips _tenexOriginalResult)
            const delegationResult = [{ type: "text", text: "..." }];

            await tracker.completeExecution({
                toolCallId: "mcp-delegate-complete",
                result: delegationResult,
                error: false,
                agentPubkey: "agent-pubkey",
            });

            // Should have published with referencedEventIds from registry (q-tags)
            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    toolName: "mcp__tenex__delegate",
                    referencedEventIds: ["mcp-delegation-event-123"],
                }),
                mockEventContext
            );

            // toolEventId should be updated
            const execution = tracker.getExecution("mcp-delegate-complete");
            expect(execution?.toolEventId).toBe("mock-event-id-123");
        });

        it("should get event IDs from registry for MCP-wrapped ask tool (fixes MCP stripping issue)", async () => {
            // Track MCP-wrapped ask tool
            await tracker.trackExecution({
                toolCallId: "mcp-ask-complete",
                toolName: "mcp__tenex__ask",
                args: { title: "Question", context: "Context", questions: [] },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Register with PendingDelegationsRegistry (simulates what AgentPublisher.ask() does)
            // This is the key fix: MCP result transformation (Claude Code SDK) strips everything,
            // but we now get event IDs from the registry which was populated at publish time
            PendingDelegationsRegistry.register("agent-pubkey", mockEventContext.conversationId, "ask-event-id-456");

            // Simulate MCP-transformed result (Claude Code SDK strips _tenexOriginalResult)
            const mcpWrappedResult = [{ type: "text", text: "..." }];

            await tracker.completeExecution({
                toolCallId: "mcp-ask-complete",
                result: mcpWrappedResult,
                error: false,
                agentPubkey: "agent-pubkey",
            });

            // Should have published with referencedEventIds (q-tags) from registry
            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    toolName: "mcp__tenex__ask",
                    referencedEventIds: ["ask-event-id-456"],
                }),
                mockEventContext
            );

            // toolEventId should be updated
            const execution = tracker.getExecution("mcp-ask-complete");
            expect(execution?.toolEventId).toBe("mock-event-id-123");
        });

        it("should not affect non-tenex MCP tools", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "other-mcp-tool",
                toolName: "mcp__github__create_issue",
                args: { title: "Test" },
                toolsObject: mockToolsObject,
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Should return the event (not null) - this is not a delegation tool
            expect(result).not.toBeNull();
            expect(result?.id).toBe("mock-event-id-123");

            // Should have published immediately
            expect(mockAgentPublisher.toolUse).toHaveBeenCalled();
        });
    });

    describe("Addressable event tool delayed publishing (report_write)", () => {
        it("should return null and not publish for report_write tool", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "report-write-call",
                toolName: "report_write",
                args: { slug: "test-report", title: "Test Report", summary: "Summary", content: "Content" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Should return null for addressable event tools
            expect(result).toBeNull();

            // Should NOT have published yet
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();

            // Should still be tracking
            expect(tracker.isTracking("report-write-call")).toBe(true);

            // Should have empty toolEventId
            const execution = tracker.getExecution("report-write-call");
            expect(execution?.toolEventId).toBe("");
        });

        it("should publish with referencedAddressableEvents on completion", async () => {
            // Track report_write tool
            await tracker.trackExecution({
                toolCallId: "report-write-complete",
                toolName: "report_write",
                args: { slug: "test-report", title: "Test Report", summary: "Summary", content: "Content" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Register with PendingDelegationsRegistry (simulates what report_write tool does)
            PendingDelegationsRegistry.registerAddressable(
                "agent-pubkey-123",
                mockEventContext.conversationId,
                "30023:agent-pubkey-123:test-report"
            );

            // Simulate result from report_write tool
            const reportWriteResult = {
                success: true,
                articleId: "nostr:naddr1...",
                slug: "test-report",
                message: "Report published",
                referencedAddressableEvents: ["30023:agent-pubkey-123:test-report"],
            };

            await tracker.completeExecution({
                toolCallId: "report-write-complete",
                result: reportWriteResult,
                error: false,
                agentPubkey: "agent-pubkey-123",
            });

            // Should have published with referencedAddressableEvents from registry
            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    toolName: "report_write",
                    referencedAddressableEvents: ["30023:agent-pubkey-123:test-report"],
                }),
                mockEventContext
            );

            // toolEventId should be updated
            const execution = tracker.getExecution("report-write-complete");
            expect(execution?.toolEventId).toBe("mock-event-id-123");
        });

        it("should handle missing referencedAddressableEvents gracefully", async () => {
            await tracker.trackExecution({
                toolCallId: "report-no-refs",
                toolName: "report_write",
                args: { slug: "test" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Result without referencedAddressableEvents
            await tracker.completeExecution({
                toolCallId: "report-no-refs",
                result: { success: true, articleId: "naddr1...", slug: "test", message: "Done" },
                error: false,
                agentPubkey: "agent-pubkey",
            });

            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    referencedAddressableEvents: [],
                }),
                mockEventContext
            );
        });

        it("should keep referencedEventIds empty for report_write", async () => {
            await tracker.trackExecution({
                toolCallId: "report-no-event-refs",
                toolName: "report_write",
                args: { slug: "test" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Register with PendingDelegationsRegistry (simulates what report_write tool does)
            PendingDelegationsRegistry.registerAddressable("agent-pubkey", mockEventContext.conversationId, "30023:pubkey:test");

            const reportWriteResult = {
                success: true,
                articleId: "nostr:naddr1...",
                slug: "test",
                message: "Done",
                referencedAddressableEvents: ["30023:pubkey:test"],
            };

            await tracker.completeExecution({
                toolCallId: "report-no-event-refs",
                result: reportWriteResult,
                error: false,
                agentPubkey: "agent-pubkey",
            });

            // Should have empty referencedEventIds (q-tags) but populated referencedAddressableEvents (a-tags)
            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    referencedEventIds: [],
                    referencedAddressableEvents: ["30023:pubkey:test"],
                }),
                mockEventContext
            );
        });

        it("should return null for MCP-wrapped report_write tool (mcp__tenex__report_write)", async () => {
            const result = await tracker.trackExecution({
                toolCallId: "mcp-report-write-call",
                toolName: "mcp__tenex__report_write",
                args: { slug: "test-report", title: "Test", summary: "Summary", content: "Content" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Should return null for MCP-wrapped addressable event tools
            expect(result).toBeNull();

            // Should NOT have published yet
            expect(mockAgentPublisher.toolUse).not.toHaveBeenCalled();

            // Should still be tracking
            expect(tracker.isTracking("mcp-report-write-call")).toBe(true);
        });

        it("should publish with referencedAddressableEvents on completion for MCP-wrapped report_write", async () => {
            await tracker.trackExecution({
                toolCallId: "mcp-report-complete",
                toolName: "mcp__tenex__report_write",
                args: { slug: "test", title: "Test", summary: "Summary", content: "Content" },
                toolsObject: {},
                agentPublisher: mockAgentPublisher,
                eventContext: mockEventContext,
            });

            // Register with PendingDelegationsRegistry (simulates what report_write tool does)
            // This is the key fix: MCP result transformation strips referencedAddressableEvents,
            // but we now get them from the registry which was populated at publish time
            PendingDelegationsRegistry.registerAddressable("agent-pubkey", mockEventContext.conversationId, "30023:agent-pubkey:test");

            // Simulate MCP-transformed result (Claude Code SDK strips custom properties)
            const reportResult = [{ type: "text", text: "Report published" }];

            await tracker.completeExecution({
                toolCallId: "mcp-report-complete",
                result: reportResult,
                error: false,
                agentPubkey: "agent-pubkey",
            });

            expect(mockAgentPublisher.toolUse).toHaveBeenCalledWith(
                expect.objectContaining({
                    toolName: "mcp__tenex__report_write",
                    referencedAddressableEvents: ["30023:agent-pubkey:test"],
                }),
                mockEventContext
            );
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
