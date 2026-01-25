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
});
