/**
 * Integration tests for ConversationStore with agent execution flow
 *
 * Tests the key integration points:
 * 1. Message building for RAL execution
 * 2. Message accumulation during prepareStep
 * 3. RAL lifecycle (create, execute, complete)
 * 4. Injection handling
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import type { ModelMessage } from "ai";
import { ConversationStore } from "@/conversations/ConversationStore";

describe("ConversationStore Agent Execution Integration", () => {
    const TEST_DIR = "/tmp/tenex-agent-integration-test";
    const PROJECT_ID = "test-project";
    const CONVERSATION_ID = "conv-integration";
    const AGENT_PUBKEY = "agent-pubkey-123";
    const USER_PUBKEY = "user-pubkey-456";

    let store: ConversationStore;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, CONVERSATION_ID);
    });

    afterEach(async () => {
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    describe("RAL Execution Lifecycle", () => {
        it("should build initial messages from user input", () => {
            // User sends a message (hydrated from Nostr event)
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "Hello, help me with a task" },
                eventId: "user-event-1",
            });

            // Create RAL for agent
            const ralNumber = store.createRal(AGENT_PUBKEY);
            expect(ralNumber).toBe(1);

            // Build messages for this RAL
            const messages = store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            expect(messages[0].content).toBe("Hello, help me with a task");
        });

        it("should accumulate messages during multi-step execution", () => {
            // Initial user message
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "Read a file for me" },
            });

            const ralNumber = store.createRal(AGENT_PUBKEY);

            // Step 1: Agent responds with text and tool call
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "I'll read that file for you." },
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            args: { path: "/tmp/test.txt" },
                        },
                    ],
                },
            });

            // Tool result
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                message: {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            toolCallId: "call_1",
                            toolName: "read_path",
                            result: "File contents here",
                        },
                    ],
                },
            });

            // Step 2: Agent's final response
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "The file contains: File contents here" }],
                },
            });

            // Complete the RAL
            store.completeRal(AGENT_PUBKEY, ralNumber);

            // Verify all messages are stored
            const allMessages = store.getAllMessages();
            expect(allMessages).toHaveLength(4);

            // Verify RAL is no longer active
            expect(store.isRalActive(AGENT_PUBKEY, ralNumber)).toBe(false);
        });

        it("should handle multi-turn conversation", async () => {
            // Turn 1: User asks, agent responds
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "What's 2+2?" },
            });

            const ral1 = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                message: { role: "assistant", content: "2+2 equals 4." },
            });
            store.completeRal(AGENT_PUBKEY, ral1);

            // Turn 2: User follows up
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "And what's 4+4?" },
            });

            const ral2 = store.createRal(AGENT_PUBKEY);

            // Build messages for RAL 2 - should include all previous messages
            const messages = store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            expect(messages).toHaveLength(3);
            expect(messages[0].content).toBe("What's 2+2?");
            expect(messages[1].content).toBe("2+2 equals 4.");
            expect(messages[2].content).toBe("And what's 4+4?");
        });
    });

    describe("Injection Handling", () => {
        it("should process injections during prepareStep", () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "Start a task" },
            });

            const ralNumber = store.createRal(AGENT_PUBKEY);

            // Simulate another RAL injecting a message
            store.addInjection({
                targetRal: { pubkey: AGENT_PUBKEY, ral: ralNumber },
                role: "user",
                content: "Urgent: stop what you're doing",
                queuedAt: Date.now(),
            });

            // Consume injections (like prepareStep would do)
            const consumed = store.consumeInjections(AGENT_PUBKEY, ralNumber);

            expect(consumed).toHaveLength(1);
            expect(consumed[0].content).toBe("Urgent: stop what you're doing");

            // Injection should now be in messages
            const messages = store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);
            expect(messages.some(m => m.content === "Urgent: stop what you're doing")).toBe(true);
        });
    });

    describe("Event ID Tracking", () => {
        it("should track published event IDs to prevent duplicates", () => {
            // Add message without eventId (during execution)
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: 1,
                message: { role: "assistant", content: "My response" },
            });

            const messages = store.getAllMessages();
            const messageIndex = messages.length - 1;

            // Simulate publishing to Nostr and getting back eventId
            const publishedEventId = "published-nostr-event-123";
            store.setEventId(messageIndex, publishedEventId);

            // Should now have the eventId
            expect(store.hasEventId(publishedEventId)).toBe(true);

            // When the event comes back via subscription, we can skip it
            expect(store.hasEventId(publishedEventId)).toBe(true);
            expect(store.hasEventId("different-event")).toBe(false);
        });
    });

    describe("Concurrent RALs", () => {
        it("should provide summary of other active RALs", () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "Do multiple things" },
            });

            // RAL 1 starts and does some work
            const ral1 = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Working on task 1" }],
                },
            });
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "research",
                            args: { query: "important topic" },
                        },
                    ],
                },
            });

            // RAL 2 starts (RAL 1 still active)
            const ral2 = store.createRal(AGENT_PUBKEY);

            // Build messages for RAL 2
            const messages = store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            // Should include user message
            expect(messages.some(m => m.role === "user")).toBe(true);

            // Should include system message summarizing RAL 1 (not RAL 1's actual messages)
            const systemMessages = messages.filter(m => m.role === "system");
            expect(systemMessages.length).toBeGreaterThan(0);

            const summaryMessage = systemMessages.find(m =>
                typeof m.content === "string" && m.content.includes("reason-act-loop (#1)")
            );
            expect(summaryMessage).toBeDefined();
            expect(summaryMessage!.content).toContain("[text-output] Working on task 1");
            expect(summaryMessage!.content).toContain("[tool research]");
        });

        it("should include completed RAL messages directly", () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "First request" },
            });

            // RAL 1 completes
            const ral1 = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                message: { role: "assistant", content: "Completed task 1" },
            });
            store.completeRal(AGENT_PUBKEY, ral1);

            // New user message
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "Second request" },
            });

            // RAL 2 starts
            const ral2 = store.createRal(AGENT_PUBKEY);
            const messages = store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            // Should include RAL 1's message directly (not summarized)
            expect(messages).toHaveLength(3);
            expect(messages[1].role).toBe("assistant");
            expect(messages[1].content).toBe("Completed task 1");

            // Should NOT have a system summary for RAL 1 (it's completed)
            const systemMessages = messages.filter(m => m.role === "system");
            expect(systemMessages).toHaveLength(0);
        });
    });

    describe("Persistence", () => {
        it("should persist and restore full execution state", async () => {
            // Execute a full conversation
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "Hello" },
                eventId: "event-1",
            });

            const ral1 = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                message: { role: "assistant", content: "Hi there!" },
            });

            // Set eventId after "publishing"
            store.setEventId(1, "event-2");

            // Add an injection
            store.addInjection({
                targetRal: { pubkey: AGENT_PUBKEY, ral: ral1 },
                role: "system",
                content: "System notification",
                queuedAt: Date.now(),
            });

            await store.save();

            // Create new store instance and load
            const store2 = new ConversationStore(TEST_DIR);
            store2.load(PROJECT_ID, CONVERSATION_ID);

            // Verify messages
            expect(store2.getAllMessages()).toHaveLength(2);
            expect(store2.hasEventId("event-1")).toBe(true);
            expect(store2.hasEventId("event-2")).toBe(true);

            // Verify active RALs
            expect(store2.isRalActive(AGENT_PUBKEY, ral1)).toBe(true);

            // Verify injections
            const injections = store2.getPendingInjections(AGENT_PUBKEY, ral1);
            expect(injections).toHaveLength(1);
        });
    });
});
