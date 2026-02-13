/**
 * Unit tests for MessageBuilder
 *
 * Tests the core functionality of buildMessagesFromEntries:
 * - Tool-call/tool-result ordering for AI SDK validation
 * - Orphaned tool-call reconciliation with synthetic error results
 * - Message deferral during pending tool execution
 */

import { describe, test, expect } from "bun:test";
import { buildMessagesFromEntries, type MessageBuilderContext } from "../MessageBuilder";
import type { ConversationEntry } from "../types";

describe("MessageBuilder", () => {
    const viewingAgentPubkey = "agent-pubkey-123";
    const otherAgentPubkey = "other-agent-456";
    const userPubkey = "user-pubkey-789";

    function createContext(overrides: Partial<MessageBuilderContext> = {}): MessageBuilderContext {
        return {
            viewingAgentPubkey,
            ralNumber: 1,
            activeRals: new Set([1]),
            totalMessages: 10,
            indexOffset: 0,
            rootAuthorPubkey: userPubkey,
            ...overrides,
        };
    }

    describe("Tool Ordering - Message Deferral", () => {
        test("defers user message between tool-call and tool-result", async () => {
            // Scenario: User sends message while tool is executing
            // Chronological order: [tool-call, user-message, tool-result]
            // Expected order: [tool-call, tool-result, user-message]
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        args: { path: "/file.txt" },
                    }],
                },
                {
                    pubkey: userPubkey,
                    content: "Hey, what are you doing?",
                    messageType: "text",
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        result: { content: "file contents" },
                    }],
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Should have 3 messages
            expect(messages).toHaveLength(3);

            // First: tool-call
            expect(messages[0].role).toBe("assistant");
            expect((messages[0].content as any[])[0].type).toBe("tool-call");

            // Second: tool-result (moved before user message)
            expect(messages[1].role).toBe("tool");
            expect((messages[1].content as any[])[0].type).toBe("tool-result");

            // Third: deferred user message
            expect(messages[2].role).toBe("user");
            expect(messages[2].content).toBe("Hey, what are you doing?");
        });

        test("defers multiple user messages between tool-call and tool-result", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        args: { path: "/file.txt" },
                    }],
                },
                {
                    pubkey: userPubkey,
                    content: "First message",
                    messageType: "text",
                },
                {
                    pubkey: userPubkey,
                    content: "Second message",
                    messageType: "text",
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        result: { content: "file contents" },
                    }],
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            expect(messages).toHaveLength(4);

            // Tool messages first
            expect(messages[0].role).toBe("assistant"); // tool-call
            expect(messages[1].role).toBe("tool"); // tool-result

            // Then deferred user messages in order
            expect(messages[2].role).toBe("user");
            expect(messages[2].content).toBe("First message");
            expect(messages[3].role).toBe("user");
            expect(messages[3].content).toBe("Second message");
        });

        test("handles multiple tool calls with interleaved user messages", async () => {
            const entries: ConversationEntry[] = [
                // First tool call
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        args: { path: "/a.txt" },
                    }],
                },
                {
                    pubkey: userPubkey,
                    content: "User interruption",
                    messageType: "text",
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        result: { content: "a" },
                    }],
                },
                // Second tool call
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-2",
                        toolName: "fs_read",
                        args: { path: "/b.txt" },
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-2",
                        toolName: "fs_read",
                        result: { content: "b" },
                    }],
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Expected order: [call-1, result-1, user, call-2, result-2]
            expect(messages).toHaveLength(5);
            expect(messages[0].role).toBe("assistant"); // call-1
            expect(messages[1].role).toBe("tool"); // result-1
            expect(messages[2].role).toBe("user"); // deferred user message
            expect(messages[3].role).toBe("assistant"); // call-2
            expect(messages[4].role).toBe("tool"); // result-2
        });

        test("defers delegation marker between tool-call and tool-result", async () => {
            // Scenario: Delegation completes while tool is executing
            // This is the bug from trace c7f72338a7f200000000000000000000
            // Chronological order: [tool-call, delegation-marker, tool-result]
            // Expected order: [tool-call, tool-result, delegation-completion-message]
            const delegationConversationId = "delegation-conv-123";
            const conversationId = "parent-conv-456";
            const delegatePubkey = "delegate-agent-789";

            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "tool-call-event",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call_j2dmakq6",
                        toolName: "delegate",
                        args: { recipient: "other-agent" },
                    }],
                },
                {
                    pubkey: delegatePubkey,
                    content: "",
                    messageType: "delegation-marker",
                    eventId: "delegation-marker-event",
                    delegationMarker: {
                        delegationConversationId,
                        parentConversationId: conversationId,
                        recipientPubkey: delegatePubkey,
                        status: "completed",
                        completedAt: Date.now(),
                    },
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "tool-result-event",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call_j2dmakq6",
                        toolName: "delegate",
                        result: { success: true },
                    }],
                },
            ];

            const ctx = createContext({
                totalMessages: entries.length,
                conversationId,
                getDelegationMessages: (convId) => {
                    if (convId === delegationConversationId) {
                        // Return some messages from the delegation
                        return [
                            {
                                pubkey: viewingAgentPubkey,
                                content: "Please do the task",
                                messageType: "text" as const,
                                targetedPubkeys: [delegatePubkey],
                            },
                            {
                                pubkey: delegatePubkey,
                                content: "Task completed successfully",
                                messageType: "text" as const,
                                targetedPubkeys: [viewingAgentPubkey],
                            },
                        ];
                    }
                    return undefined;
                },
            });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Should have 3 messages in correct order
            expect(messages).toHaveLength(3);

            // First: tool-call
            expect(messages[0].role).toBe("assistant");
            expect((messages[0].content as any[])[0].type).toBe("tool-call");
            expect((messages[0].content as any[])[0].toolCallId).toBe("call_j2dmakq6");

            // Second: tool-result (should come before delegation completion)
            expect(messages[1].role).toBe("tool");
            expect((messages[1].content as any[])[0].type).toBe("tool-result");
            expect((messages[1].content as any[])[0].toolCallId).toBe("call_j2dmakq6");

            // Third: deferred delegation completion message
            expect(messages[2].role).toBe("user");
            expect(messages[2].content).toContain("DELEGATION COMPLETED");
        });

        test("defers nested delegation marker between tool-call and tool-result", async () => {
            // Scenario: Nested delegation marker arrives during tool execution
            const delegationConversationId = "nested-delegation-123";
            const parentConversationId = "different-parent-456";
            const currentConversationId = "current-conv-789";
            const delegatePubkey = "nested-delegate-pubkey";

            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "tool-call-event",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-nested",
                        toolName: "some_tool",
                        args: {},
                    }],
                },
                {
                    pubkey: delegatePubkey,
                    content: "",
                    messageType: "delegation-marker",
                    eventId: "nested-marker-event",
                    delegationMarker: {
                        delegationConversationId,
                        // Different parent = nested marker
                        parentConversationId,
                        recipientPubkey: delegatePubkey,
                        status: "completed",
                        completedAt: Date.now(),
                    },
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "tool-result-event",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-nested",
                        toolName: "some_tool",
                        result: { data: "result" },
                    }],
                },
            ];

            const ctx = createContext({
                totalMessages: entries.length,
                conversationId: currentConversationId,
            });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Should have 3 messages in correct order
            expect(messages).toHaveLength(3);

            // First: tool-call
            expect(messages[0].role).toBe("assistant");
            expect((messages[0].content as any[])[0].toolCallId).toBe("call-nested");

            // Second: tool-result
            expect(messages[1].role).toBe("tool");
            expect((messages[1].content as any[])[0].toolCallId).toBe("call-nested");

            // Third: deferred nested delegation marker (minimal reference)
            expect(messages[2].role).toBe("user");
            expect(messages[2].content).toContain("Delegation to");
            expect(messages[2].content).toContain("completed");
        });

        test("deferred delegation marker gets user role even when recipient equals viewer (self-delegation)", async () => {
            // Edge case: delegation marker where recipientPubkey === viewingAgentPubkey
            // This could happen with self-delegation or nested delegation back to same agent
            // Without explicit role: "user", deriveRole() would produce "assistant"
            const conversationId = "self-delegation-conv";
            const delegationConversationId = "self-deleg-123";

            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "tool-call-event",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-self",
                        toolName: "delegate",
                        args: { recipient: "self" },
                    }],
                },
                {
                    // CRITICAL: recipientPubkey === viewingAgentPubkey (self-delegation scenario)
                    pubkey: viewingAgentPubkey,
                    content: "",
                    messageType: "delegation-marker",
                    eventId: "self-delegation-marker",
                    delegationMarker: {
                        delegationConversationId,
                        parentConversationId: conversationId,
                        recipientPubkey: viewingAgentPubkey, // Same as viewing agent!
                        status: "completed",
                        completedAt: Date.now(),
                    },
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "tool-result-event",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-self",
                        toolName: "delegate",
                        result: { success: true },
                    }],
                },
            ];

            const ctx = createContext({
                totalMessages: entries.length,
                conversationId,
                getDelegationMessages: () => [
                    {
                        pubkey: viewingAgentPubkey,
                        content: "Self-delegated task",
                        messageType: "text" as const,
                        targetedPubkeys: [viewingAgentPubkey],
                    },
                ],
            });
            const messages = await buildMessagesFromEntries(entries, ctx);

            expect(messages).toHaveLength(3);

            // First: tool-call (assistant)
            expect(messages[0].role).toBe("assistant");

            // Second: tool-result (tool)
            expect(messages[1].role).toBe("tool");

            // Third: deferred delegation - MUST be user role even though recipientPubkey === viewingAgentPubkey
            expect(messages[2].role).toBe("user");
            expect(messages[2].content).toContain("DELEGATION COMPLETED");
        });
    });

    describe("Orphaned Tool-Call Reconciliation", () => {
        test("injects synthetic error result for orphaned tool-call", async () => {
            // Scenario: Tool call exists but result was never stored (RAL interruption)
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "orphan-call-1",
                        toolName: "shell",
                        args: { command: "long-running-command" },
                    }],
                },
                // No tool-result for orphan-call-1
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Should have 2 messages: tool-call + synthetic result
            expect(messages).toHaveLength(2);

            // First: original tool-call
            expect(messages[0].role).toBe("assistant");
            expect((messages[0].content as any[])[0].toolCallId).toBe("orphan-call-1");

            // Second: synthetic error result
            expect(messages[1].role).toBe("tool");
            const resultContent = (messages[1].content as any[])[0];
            expect(resultContent.type).toBe("tool-result");
            expect(resultContent.toolCallId).toBe("orphan-call-1");
            expect(resultContent.toolName).toBe("shell");
            expect(resultContent.output.value).toContain("interrupted");
        });

        test("injects synthetic results for multiple orphaned tool-calls", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    toolData: [
                        {
                            type: "tool-call",
                            toolCallId: "orphan-1",
                            toolName: "fs_read",
                            args: { path: "/a.txt" },
                        },
                        {
                            type: "tool-call",
                            toolCallId: "orphan-2",
                            toolName: "fs_read",
                            args: { path: "/b.txt" },
                        },
                    ],
                },
                // No results for either call
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Should have tool-call + 2 synthetic results
            expect(messages).toHaveLength(3);
            expect(messages[0].role).toBe("assistant");
            expect(messages[1].role).toBe("tool");
            expect(messages[2].role).toBe("tool");

            // Both synthetic results should exist
            const resultIds = [
                (messages[1].content as any[])[0].toolCallId,
                (messages[2].content as any[])[0].toolCallId,
            ];
            expect(resultIds).toContain("orphan-1");
            expect(resultIds).toContain("orphan-2");
        });

        test("handles mixed orphaned and resolved tool-calls", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "resolved-call",
                        toolName: "fs_read",
                        args: { path: "/resolved.txt" },
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "resolved-call",
                        toolName: "fs_read",
                        result: { content: "resolved" },
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "orphan-call",
                        toolName: "shell",
                        args: { command: "interrupted" },
                    }],
                },
                // No result for orphan-call
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Should have: call-1, result-1, call-2, synthetic-result-2
            expect(messages).toHaveLength(4);

            // Check resolved call has real result
            expect((messages[1].content as any[])[0].toolCallId).toBe("resolved-call");
            expect((messages[1].content as any[])[0].result).toBeDefined();

            // Check orphaned call has synthetic result
            expect((messages[3].content as any[])[0].toolCallId).toBe("orphan-call");
            expect((messages[3].content as any[])[0].output.value).toContain("interrupted");
        });
    });

    describe("Edge Cases", () => {
        test("handles empty entries array", async () => {
            const ctx = createContext({ totalMessages: 0 });
            const messages = await buildMessagesFromEntries([], ctx);
            expect(messages).toHaveLength(0);
        });

        test("handles text-only conversation", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: userPubkey,
                    content: "Hello",
                    messageType: "text",
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "Hi there!",
                    messageType: "text",
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            expect(messages).toHaveLength(2);
            expect(messages[0].role).toBe("user");
            expect(messages[1].role).toBe("assistant");
        });

        test("flushes remaining deferred messages at end", async () => {
            // Edge case: Messages deferred but no tool-result arrives
            // (though this is covered by orphan reconciliation too)
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "pending-call",
                        toolName: "fs_read",
                        args: { path: "/file.txt" },
                    }],
                },
                {
                    pubkey: userPubkey,
                    content: "Deferred message",
                    messageType: "text",
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Should have: tool-call, synthetic-result, deferred-user-message
            expect(messages).toHaveLength(3);

            // Deferred message should be at the end
            expect(messages[2].role).toBe("user");
            expect(messages[2].content).toBe("Deferred message");
        });
    });

    describe("Role Derivation", () => {
        test("assigns assistant role to own messages", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "I am the agent speaking",
                    messageType: "text",
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            expect(messages[0].role).toBe("assistant");
        });

        test("assigns user role to other agent messages", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: otherAgentPubkey,
                    ral: 1,
                    content: "Message from another agent",
                    messageType: "text",
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            expect(messages[0].role).toBe("user");
        });

        test("assigns user role to human messages", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: userPubkey,
                    content: "Human user message",
                    messageType: "text",
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            expect(messages[0].role).toBe("user");
        });
    });

    describe("Image Placeholder Strategy", () => {
        test("first image appearance shows full image URL", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "event-1",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "screenshot",
                        args: {},
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "event-2",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "screenshot",
                        output: {
                            type: "text",
                            value: "Screenshot saved: https://example.com/first.png",
                        },
                    }],
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Tool result should preserve full image URL on first appearance
            expect(messages).toHaveLength(2);
            const toolResult = messages[1];
            expect(toolResult.role).toBe("tool");
            const output = (toolResult.content as any[])[0].output;
            const outputValue = typeof output === "string" ? output : output.value;
            expect(outputValue).toContain("https://example.com/first.png");
            expect(outputValue).not.toContain("[Image:");
        });

        test("second image appearance is replaced with placeholder", async () => {
            const entries: ConversationEntry[] = [
                // First screenshot - full image
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "event-1",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "screenshot",
                        args: {},
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "event-2",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "screenshot",
                        output: {
                            type: "text",
                            value: "Screenshot saved: https://example.com/same.png",
                        },
                    }],
                },
                // Agent response
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "I see the screenshot",
                    messageType: "text",
                },
                // Second screenshot with SAME image URL - should be placeholder
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "event-3",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-2",
                        toolName: "screenshot",
                        args: {},
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "event-4",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-2",
                        toolName: "screenshot",
                        output: {
                            type: "text",
                            value: "Screenshot saved: https://example.com/same.png",
                        },
                    }],
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // First tool result should have full URL
            const firstToolResult = messages[1];
            const firstOutput = (firstToolResult.content as any[])[0].output;
            const firstValue = typeof firstOutput === "string" ? firstOutput : firstOutput.value;
            expect(firstValue).toContain("https://example.com/same.png");
            expect(firstValue).not.toContain("[Image:");

            // Second tool result (same URL) should have placeholder
            const secondToolResult = messages[4]; // [call-1, result-1, text, call-2, result-2]
            const secondOutput = (secondToolResult.content as any[])[0].output;
            const secondValue = typeof secondOutput === "string" ? secondOutput : secondOutput.value;
            expect(secondValue).toContain("[Image:");
            expect(secondValue).toContain("same.png");
            expect(secondValue).toContain("fs_read");
            expect(secondValue).toContain("event-4");
        });

        test("handles multiple different images in same tool result", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "event-1",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "multi-screenshot",
                        args: {},
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "event-2",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "multi-screenshot",
                        output: {
                            type: "text",
                            value: "Screenshots:\n- https://example.com/a.png\n- https://example.com/b.png",
                        },
                    }],
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            const toolResult = messages[1];
            const output = (toolResult.content as any[])[0].output;
            const outputValue = typeof output === "string" ? output : output.value;

            // Both images should be preserved (first appearance)
            expect(outputValue).toContain("https://example.com/a.png");
            expect(outputValue).toContain("https://example.com/b.png");
            expect(outputValue).not.toContain("[Image:");
        });

        test("mixed new and seen images in same tool result", async () => {
            const entries: ConversationEntry[] = [
                // First screenshot
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "event-1",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "screenshot",
                        args: {},
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "event-2",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "screenshot",
                        output: {
                            type: "text",
                            value: "Old: https://example.com/old.png",
                        },
                    }],
                },
                // Second screenshot with mixed old+new
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "event-3",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-2",
                        toolName: "multi-screenshot",
                        args: {},
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "event-4",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-2",
                        toolName: "multi-screenshot",
                        output: {
                            type: "text",
                            value: "Old: https://example.com/old.png\nNew: https://example.com/new.png",
                        },
                    }],
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // Second tool result should have mixed content
            const secondToolResult = messages[3]; // [call-1, result-1, call-2, result-2]
            const output = (secondToolResult.content as any[])[0].output;
            const outputValue = typeof output === "string" ? output : output.value;

            // Old image should be placeholder
            expect(outputValue).toContain("[Image:");
            expect(outputValue).toContain("old.png");

            // New image should be preserved
            expect(outputValue).toContain("https://example.com/new.png");
        });

        test("tool results without images pass through unchanged", async () => {
            const entries: ConversationEntry[] = [
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "event-1",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        args: { path: "/file.txt" },
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "event-2",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        output: {
                            type: "text",
                            value: "File contents: hello world",
                        },
                    }],
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            const toolResult = messages[1];
            const output = (toolResult.content as any[])[0].output;
            const outputValue = typeof output === "string" ? output : output.value;

            expect(outputValue).toBe("File contents: hello world");
            expect(outputValue).not.toContain("[Image:");
        });

        test("image in user text message is tracked but not replaced", async () => {
            // User messages might contain image URLs in text
            // We track them but don't replace them (user messages are user's content)
            const entries: ConversationEntry[] = [
                {
                    pubkey: userPubkey,
                    content: "Look at this image: https://example.com/user-img.png",
                    messageType: "text",
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-call",
                    eventId: "event-1",
                    toolData: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "analyze",
                        args: {},
                    }],
                },
                {
                    pubkey: viewingAgentPubkey,
                    ral: 1,
                    content: "",
                    messageType: "tool-result",
                    eventId: "event-2",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "analyze",
                        output: {
                            type: "text",
                            value: "Analyzed: https://example.com/user-img.png",
                        },
                    }],
                },
            ];

            const ctx = createContext({ totalMessages: entries.length });
            const messages = await buildMessagesFromEntries(entries, ctx);

            // User message with image is converted to multimodal format
            // It should still contain the URL in the text part (not replaced)
            const userMessage = messages[0];
            const userContent = userMessage.content;

            // Content could be a string or multimodal array
            if (Array.isArray(userContent)) {
                // Multimodal format - check the text part contains the URL
                const textPart = userContent.find((p: any) => p.type === "text");
                expect(textPart).toBeDefined();
                expect((textPart as any).text).toContain("https://example.com/user-img.png");
            } else {
                // String format
                expect(userContent).toContain("https://example.com/user-img.png");
            }

            // Tool result with same image should have placeholder
            // (because the user message already "showed" it)
            const toolResult = messages[2];
            const output = (toolResult.content as any[])[0].output;
            const outputValue = typeof output === "string" ? output : output.value;
            expect(outputValue).toContain("[Image:");
            expect(outputValue).toContain("user-img.png");
        });
    });
});
