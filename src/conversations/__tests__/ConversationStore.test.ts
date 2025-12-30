/**
 * TDD tests for ConversationStore
 *
 * ConversationStore is the single source of truth for conversation state.
 * It handles:
 * - Persistent storage of messages
 * - RAL lifecycle management
 * - Message visibility rules
 * - Injection queue
 * - Nostr event hydration
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import type { ModelMessage } from "ai";
import {
    ConversationStore,
    type ConversationEntry,
    type Injection,
} from "../ConversationStore";

describe("ConversationStore", () => {
    const TEST_DIR = "/tmp/tenex-test-conversations";
    const PROJECT_ID = "test-project";
    const CONVERSATION_ID = "conv-123";
    const AGENT1_PUBKEY = "agent1-pubkey-abc";
    const AGENT2_PUBKEY = "agent2-pubkey-def";
    const USER_PUBKEY = "user-pubkey-xyz";

    let store: ConversationStore;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
    });

    afterEach(async () => {
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    describe("File Operations", () => {
        it("should create conversation file on first save", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            const entry: ConversationEntry = {
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "hello" },
            };
            store.addMessage(entry);
            await store.save();

            const filePath = join(
                TEST_DIR,
                "projects",
                PROJECT_ID,
                "conversations",
                `${CONVERSATION_ID}.json`
            );
            const content = await readFile(filePath, "utf-8");
            const data = JSON.parse(content);

            expect(data.messages).toHaveLength(1);
            expect(data.messages[0].pubkey).toBe(USER_PUBKEY);
        });

        it("should load existing conversation from file", async () => {
            // First create and save
            store.load(PROJECT_ID, CONVERSATION_ID);
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "hello" },
            });
            await store.save();

            // Create new store instance and load
            const store2 = new ConversationStore(TEST_DIR);
            store2.load(PROJECT_ID, CONVERSATION_ID);

            const messages = store2.getAllMessages();
            expect(messages).toHaveLength(1);
            expect(messages[0].pubkey).toBe(USER_PUBKEY);
        });

        it("should return empty state for new conversation", () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            expect(store.getAllMessages()).toHaveLength(0);
            expect(store.getActiveRals(AGENT1_PUBKEY)).toHaveLength(0);
        });
    });

    describe("RAL Lifecycle", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should create RAL with sequential numbers", () => {
            const ral1 = store.createRal(AGENT1_PUBKEY);
            const ral2 = store.createRal(AGENT1_PUBKEY);
            const ral3 = store.createRal(AGENT1_PUBKEY);

            expect(ral1).toBe(1);
            expect(ral2).toBe(2);
            expect(ral3).toBe(3);
        });

        it("should track active RALs", () => {
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);

            const activeRals = store.getActiveRals(AGENT1_PUBKEY);
            expect(activeRals).toEqual([1, 2]);
        });

        it("should mark RAL as complete", () => {
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);
            store.completeRal(AGENT1_PUBKEY, 1);

            const activeRals = store.getActiveRals(AGENT1_PUBKEY);
            expect(activeRals).toEqual([2]);
            expect(store.isRalActive(AGENT1_PUBKEY, 1)).toBe(false);
            expect(store.isRalActive(AGENT1_PUBKEY, 2)).toBe(true);
        });

        it("should maintain separate RAL sequences per agent", () => {
            const agent1Ral1 = store.createRal(AGENT1_PUBKEY);
            const agent2Ral1 = store.createRal(AGENT2_PUBKEY);
            const agent1Ral2 = store.createRal(AGENT1_PUBKEY);

            expect(agent1Ral1).toBe(1);
            expect(agent2Ral1).toBe(1);
            expect(agent1Ral2).toBe(2);
        });

        it("should register externally-assigned RAL via ensureRalActive", () => {
            // Use ensureRalActive to register an externally-assigned RAL number
            store.ensureRalActive(AGENT1_PUBKEY, 5);

            expect(store.isRalActive(AGENT1_PUBKEY, 5)).toBe(true);
            expect(store.getActiveRals(AGENT1_PUBKEY)).toEqual([5]);
        });

        it("should not duplicate RAL when ensureRalActive called multiple times", () => {
            store.ensureRalActive(AGENT1_PUBKEY, 3);
            store.ensureRalActive(AGENT1_PUBKEY, 3);
            store.ensureRalActive(AGENT1_PUBKEY, 3);

            expect(store.getActiveRals(AGENT1_PUBKEY)).toEqual([3]);
        });

        it("should update nextRalNumber when ensureRalActive uses higher number", () => {
            store.ensureRalActive(AGENT1_PUBKEY, 10);

            // Next createRal should return 11
            const nextRal = store.createRal(AGENT1_PUBKEY);
            expect(nextRal).toBe(11);
        });
    });

    describe("Message Visibility Rules", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should include all user messages for any agent", () => {
            // User message
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "hello" },
            });

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
        });

        it("should include all messages from same agent completed RALs", () => {
            // RAL 1 - completed
            store.createRal(AGENT1_PUBKEY);
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "I will help" }],
                },
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            args: { path: "/tmp/test" },
                        },
                    ],
                },
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                message: {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            result: "file content",
                        },
                    ],
                },
            });
            store.completeRal(AGENT1_PUBKEY, 1);

            // RAL 2 - current
            const ral2 = store.createRal(AGENT1_PUBKEY);
            const messages = store.buildMessagesForRal(AGENT1_PUBKEY, ral2);

            // Should include all messages from completed RAL 1
            expect(messages).toHaveLength(3);
        });

        it("should exclude messages from other active RALs, add summary instead", () => {
            // RAL 1 - active (not completed)
            store.createRal(AGENT1_PUBKEY);
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Working on it" }],
                },
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            args: { path: "/tmp/test" },
                        },
                    ],
                },
            });

            // RAL 2 - current
            const ral2 = store.createRal(AGENT1_PUBKEY);
            const messages = store.buildMessagesForRal(AGENT1_PUBKEY, ral2);

            // Should NOT include RAL 1 messages directly
            // Should include a system message summarizing RAL 1
            const systemMessages = messages.filter((m) => m.role === "system");
            expect(systemMessages).toHaveLength(1);
            expect(systemMessages[0].content).toContain(
                "reason-act-loop (#1) executing"
            );
            expect(systemMessages[0].content).toContain("[text-output]");
            expect(systemMessages[0].content).toContain("[tool read_path]");
        });

        it("should include only text outputs from other agents", () => {
            // Agent 2 messages
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "I am agent 2" }],
                },
            });
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            args: {},
                        },
                    ],
                },
            });
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                message: {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            result: "content",
                        },
                    ],
                },
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            // Agent 1 RAL
            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            // Should only include the text output, not tool calls/results
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("assistant");
            expect(messages[0].content).toBe("I am agent 2");
        });

        it("should filter mixed content to extract only text", () => {
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Let me check" },
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            args: {},
                        },
                    ],
                },
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(messages[0].content).toBe("Let me check");
        });

        it("should exclude messages with only tool calls from other agents", () => {
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            args: {},
                        },
                    ],
                },
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(0);
        });
    });

    describe("RAL Summary Generation", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should generate summary with text outputs and tool calls", () => {
            store.createRal(AGENT1_PUBKEY);
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "I will research this" }],
                },
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            args: { path: "/tmp/test.txt" },
                        },
                    ],
                },
            });

            const summary = store.buildRalSummary(AGENT1_PUBKEY, 1);

            expect(summary).toContain("reason-act-loop (#1) executing");
            expect(summary).toContain("[text-output] I will research this");
            expect(summary).toContain('[tool read_path] path="/tmp/test.txt"');
        });

        it("should include tool args in summary", () => {
            store.createRal(AGENT1_PUBKEY);
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "write_file",
                            args: {
                                path: "/tmp/out.txt",
                                content: "hello world",
                            },
                        },
                    ],
                },
            });

            const summary = store.buildRalSummary(AGENT1_PUBKEY, 1);

            expect(summary).toContain("[tool write_file]");
            expect(summary).toContain('path="/tmp/out.txt"');
            expect(summary).toContain('content="hello world"');
        });
    });

    describe("Injection Queue", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should add injection to queue", () => {
            store.createRal(AGENT1_PUBKEY);

            const injection: Injection = {
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 1 },
                role: "user",
                content: "injected message",
                queuedAt: Date.now(),
            };

            store.addInjection(injection);

            const injections = store.getPendingInjections(AGENT1_PUBKEY, 1);
            expect(injections).toHaveLength(1);
            expect(injections[0].content).toBe("injected message");
        });

        it("should consume injections and move to messages", () => {
            store.createRal(AGENT1_PUBKEY);

            store.addInjection({
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 1 },
                role: "user",
                content: "injected message",
                queuedAt: Date.now(),
            });

            const consumed = store.consumeInjections(AGENT1_PUBKEY, 1);
            expect(consumed).toHaveLength(1);

            // Should be in messages now
            const messages = store.getAllMessages();
            expect(messages).toHaveLength(1);
            expect(messages[0].message.content).toBe("injected message");

            // Should not be in queue anymore
            const remaining = store.getPendingInjections(AGENT1_PUBKEY, 1);
            expect(remaining).toHaveLength(0);
        });

        it("should only consume injections for target RAL", () => {
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);

            store.addInjection({
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 1 },
                role: "user",
                content: "for RAL 1",
                queuedAt: Date.now(),
            });
            store.addInjection({
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 2 },
                role: "user",
                content: "for RAL 2",
                queuedAt: Date.now(),
            });

            const consumed = store.consumeInjections(AGENT1_PUBKEY, 1);
            expect(consumed).toHaveLength(1);
            expect(consumed[0].content).toBe("for RAL 1");

            // RAL 2 injection should still be pending
            const remaining = store.getPendingInjections(AGENT1_PUBKEY, 2);
            expect(remaining).toHaveLength(1);
        });
    });

    describe("Event ID Tracking", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should track event IDs", () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "hello" },
                eventId: "event-123",
            });

            expect(store.hasEventId("event-123")).toBe(true);
            expect(store.hasEventId("event-456")).toBe(false);
        });

        it("should allow setting event ID after message creation", () => {
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                message: { role: "assistant", content: "response" },
            });

            const messages = store.getAllMessages();
            const index = messages.length - 1;

            store.setEventId(index, "published-event-id");

            expect(store.hasEventId("published-event-id")).toBe(true);
            expect(messages[index].eventId).toBe("published-event-id");
        });
    });

    describe("Persistence", () => {
        it("should persist activeRal state", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);
            store.completeRal(AGENT1_PUBKEY, 1);
            await store.save();

            const store2 = new ConversationStore(TEST_DIR);
            store2.load(PROJECT_ID, CONVERSATION_ID);

            expect(store2.getActiveRals(AGENT1_PUBKEY)).toEqual([2]);
            expect(store2.isRalActive(AGENT1_PUBKEY, 1)).toBe(false);
        });

        it("should persist injections", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            store.createRal(AGENT1_PUBKEY);
            store.addInjection({
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 1 },
                role: "user",
                content: "pending injection",
                queuedAt: 1234567890,
            });
            await store.save();

            const store2 = new ConversationStore(TEST_DIR);
            store2.load(PROJECT_ID, CONVERSATION_ID);

            const injections = store2.getPendingInjections(AGENT1_PUBKEY, 1);
            expect(injections).toHaveLength(1);
            expect(injections[0].content).toBe("pending injection");
        });

        it("should persist RAL number sequence", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);
            await store.save();

            const store2 = new ConversationStore(TEST_DIR);
            store2.load(PROJECT_ID, CONVERSATION_ID);
            const nextRal = store2.createRal(AGENT1_PUBKEY);

            expect(nextRal).toBe(3);
        });
    });
});
