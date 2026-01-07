/**
 * Unit tests for MessageSyncer
 *
 * Tests that MessageSyncer correctly syncs tool calls and results
 * from AI SDK step.messages to ConversationStore.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ModelMessage } from "ai";

import { MessageSyncer } from "../MessageSyncer";
import { ConversationStore } from "@/conversations/ConversationStore";

describe("MessageSyncer", () => {
    const testDir = join(tmpdir(), `message-syncer-test-${Date.now()}`);
    const agentPubkey = "test-agent-pubkey";
    const ralNumber = 1;

    beforeEach(() => {
        mkdirSync(join(testDir, "conversations"), { recursive: true });
        ConversationStore.initialize(testDir, [agentPubkey]);
    });

    afterEach(() => {
        ConversationStore.reset();
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    test("syncs missing tool result to ConversationStore", () => {
        const store = ConversationStore.getOrLoad("test-conv-1");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        const messages: ModelMessage[] = [
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "call-123",
                        toolName: "fs_read",
                        result: { error: "ENOENT: no such file or directory" },
                    },
                ],
            },
        ];

        // Before sync - no tool result
        expect(store.hasToolResult("call-123")).toBe(false);

        // Sync
        syncer.syncFromSDK(messages);

        // After sync - tool result exists
        expect(store.hasToolResult("call-123")).toBe(true);

        // Verify the message was added correctly
        const allMessages = store.getAllMessages();
        const toolResults = allMessages.filter((m) => m.messageType === "tool-result");
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].pubkey).toBe(agentPubkey);
        expect(toolResults[0].ral).toBe(ralNumber);
    });

    test("syncs missing tool call to ConversationStore", () => {
        const store = ConversationStore.getOrLoad("test-conv-2");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        const messages: ModelMessage[] = [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "call-456",
                        toolName: "fs_read",
                        args: { path: "/some/file.txt" },
                    },
                ],
            },
        ];

        // Before sync - no tool call
        expect(store.hasToolCall("call-456")).toBe(false);

        // Sync
        syncer.syncFromSDK(messages);

        // After sync - tool call exists
        expect(store.hasToolCall("call-456")).toBe(true);

        // Verify the message was added correctly
        const allMessages = store.getAllMessages();
        const toolCalls = allMessages.filter((m) => m.messageType === "tool-call");
        expect(toolCalls).toHaveLength(1);
    });

    test("does not duplicate existing tool result", () => {
        const store = ConversationStore.getOrLoad("test-conv-3");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        // Pre-add a tool result
        store.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "",
            messageType: "tool-result",
            toolData: [
                {
                    type: "tool-result",
                    toolCallId: "call-existing",
                    toolName: "fs_read",
                    result: { text: "file content" },
                },
            ],
        });

        const messagesBefore = store.getAllMessages();
        expect(messagesBefore.filter((m) => m.messageType === "tool-result")).toHaveLength(1);

        // Try to sync the same tool result
        const messages: ModelMessage[] = [
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "call-existing",
                        toolName: "fs_read",
                        result: { text: "file content" },
                    },
                ],
            },
        ];

        syncer.syncFromSDK(messages);

        // Should still have only 1 tool result (no duplicate)
        const messagesAfter = store.getAllMessages();
        expect(messagesAfter.filter((m) => m.messageType === "tool-result")).toHaveLength(1);
    });

    test("does not duplicate existing tool call", () => {
        const store = ConversationStore.getOrLoad("test-conv-4");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        // Pre-add a tool call
        store.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "",
            messageType: "tool-call",
            toolData: [
                {
                    type: "tool-call",
                    toolCallId: "call-existing-2",
                    toolName: "shell",
                    args: { command: "ls" },
                },
            ],
        });

        const messagesBefore = store.getAllMessages();
        expect(messagesBefore.filter((m) => m.messageType === "tool-call")).toHaveLength(1);

        // Try to sync the same tool call
        const messages: ModelMessage[] = [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "call-existing-2",
                        toolName: "shell",
                        args: { command: "ls" },
                    },
                ],
            },
        ];

        syncer.syncFromSDK(messages);

        // Should still have only 1 tool call (no duplicate)
        const messagesAfter = store.getAllMessages();
        expect(messagesAfter.filter((m) => m.messageType === "tool-call")).toHaveLength(1);
    });

    test("handles assistant message with mixed content (text + tool-call)", () => {
        const store = ConversationStore.getOrLoad("test-conv-5");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        const messages: ModelMessage[] = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Let me read that file for you." },
                    {
                        type: "tool-call",
                        toolCallId: "call-mixed",
                        toolName: "fs_read",
                        args: { path: "/file.txt" },
                    },
                ],
            },
        ];

        syncer.syncFromSDK(messages);

        // Tool call should be synced
        expect(store.hasToolCall("call-mixed")).toBe(true);

        // Only tool-call message added, not text
        const allMessages = store.getAllMessages();
        expect(allMessages.filter((m) => m.messageType === "tool-call")).toHaveLength(1);
        expect(allMessages.filter((m) => m.messageType === "text")).toHaveLength(0);
    });

    test("handles multiple tool calls in single message", () => {
        const store = ConversationStore.getOrLoad("test-conv-6");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        const messages: ModelMessage[] = [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "call-a",
                        toolName: "fs_read",
                        args: { path: "/a.txt" },
                    },
                    {
                        type: "tool-call",
                        toolCallId: "call-b",
                        toolName: "fs_read",
                        args: { path: "/b.txt" },
                    },
                ],
            },
        ];

        syncer.syncFromSDK(messages);

        expect(store.hasToolCall("call-a")).toBe(true);
        expect(store.hasToolCall("call-b")).toBe(true);

        const toolCalls = store.getAllMessages().filter((m) => m.messageType === "tool-call");
        expect(toolCalls).toHaveLength(2);
    });

    test("handles multiple tool results in single message", () => {
        const store = ConversationStore.getOrLoad("test-conv-7");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        const messages: ModelMessage[] = [
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "call-x",
                        toolName: "fs_read",
                        result: { text: "content x" },
                    },
                    {
                        type: "tool-result",
                        toolCallId: "call-y",
                        toolName: "fs_read",
                        result: { error: "ENOENT" },
                    },
                ],
            },
        ];

        syncer.syncFromSDK(messages);

        expect(store.hasToolResult("call-x")).toBe(true);
        expect(store.hasToolResult("call-y")).toBe(true);

        const toolResults = store.getAllMessages().filter((m) => m.messageType === "tool-result");
        expect(toolResults).toHaveLength(2);
    });

    test("handles empty messages array", () => {
        const store = ConversationStore.getOrLoad("test-conv-8");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        // Should not throw
        syncer.syncFromSDK([]);

        expect(store.getAllMessages()).toHaveLength(0);
    });

    test("handles messages without content array", () => {
        const store = ConversationStore.getOrLoad("test-conv-9");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        const messages: ModelMessage[] = [
            {
                role: "user",
                content: [{ type: "text", text: "hello" }],
            },
            {
                role: "assistant",
                content: "plain string content" as any, // Non-array content
            },
        ];

        // Should not throw
        syncer.syncFromSDK(messages);

        expect(store.getAllMessages()).toHaveLength(0);
    });

    test("syncs tool call and its result from full conversation", () => {
        const store = ConversationStore.getOrLoad("test-conv-10");
        const syncer = new MessageSyncer(store, agentPubkey, ralNumber);

        // Simulate a full conversation with tool call and result
        const messages: ModelMessage[] = [
            {
                role: "user",
                content: [{ type: "text", text: "read /nonexistent.txt" }],
            },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "I'll read that file." },
                    {
                        type: "tool-call",
                        toolCallId: "call-full",
                        toolName: "fs_read",
                        args: { path: "/nonexistent.txt" },
                    },
                ],
            },
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "call-full",
                        toolName: "fs_read",
                        result: { error: "ENOENT: no such file" },
                    },
                ],
            },
        ];

        syncer.syncFromSDK(messages);

        // Both tool call and result should be synced
        expect(store.hasToolCall("call-full")).toBe(true);
        expect(store.hasToolResult("call-full")).toBe(true);

        const allMessages = store.getAllMessages();
        expect(allMessages.filter((m) => m.messageType === "tool-call")).toHaveLength(1);
        expect(allMessages.filter((m) => m.messageType === "tool-result")).toHaveLength(1);
    });
});
