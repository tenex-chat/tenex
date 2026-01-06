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
import type { ToolCallPart, ToolResultPart } from "ai";
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
        it("should build initial messages from user input", async () => {
            // User sends a message (hydrated from Nostr event)
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Hello, help me with a task",
                messageType: "text",
                eventId: "user-event-1",
            });

            // Create RAL for agent
            const ralNumber = store.createRal(AGENT_PUBKEY);
            expect(ralNumber).toBe(1);

            // Build messages for this RAL
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            // Content includes attribution prefix
            expect(messages[0].content).toContain("Hello, help me with a task");
        });

        it("should accumulate messages during multi-step execution", () => {
            // Initial user message
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Read a file for me",
                messageType: "text",
            });

            const ralNumber = store.createRal(AGENT_PUBKEY);

            // Step 1: Agent responds with text
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "I'll read that file for you.",
                messageType: "text",
            });

            // Step 1: Agent makes tool call
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "read_path",
                    input: { path: "/tmp/test.txt" },
                }] as ToolCallPart[],
            });

            // Tool result
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "",
                messageType: "tool-result",
                toolData: [{
                    type: "tool-result",
                    toolCallId: "call_1",
                    toolName: "read_path",
                    output: { type: "text", value: "File contents here" },
                }] as ToolResultPart[],
            });

            // Step 2: Agent's final response
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "The file contains: File contents here",
                messageType: "text",
            });

            // Complete the RAL
            store.completeRal(AGENT_PUBKEY, ralNumber);

            // Verify all messages are stored
            const allMessages = store.getAllMessages();
            expect(allMessages).toHaveLength(5);

            // Verify RAL is no longer active
            expect(store.isRalActive(AGENT_PUBKEY, ralNumber)).toBe(false);
        });

        it("should handle multi-turn conversation", async () => {
            // Turn 1: User asks, agent responds
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "What's 2+2?",
                messageType: "text",
            });

            const ral1 = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                content: "2+2 equals 4.",
                messageType: "text",
            });
            store.completeRal(AGENT_PUBKEY, ral1);

            // Turn 2: User follows up
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "And what's 4+4?",
                messageType: "text",
            });

            const ral2 = store.createRal(AGENT_PUBKEY);

            // Build messages for RAL 2 - should include all previous messages
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            expect(messages).toHaveLength(3);
            // Messages include attribution prefix
            expect(messages[0].content).toContain("What's 2+2?");
            expect(messages[1].content).toContain("2+2 equals 4.");
            expect(messages[2].content).toContain("And what's 4+4?");
        });
    });

    describe("Injection Handling", () => {
        it("should process injections during prepareStep", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Start a task",
                messageType: "text",
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

            // Injection should now be in messages (the consumeInjections adds them)
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);
            const hasInjection = messages.some(m =>
                typeof m.content === "string" && m.content.includes("Urgent: stop what you're doing")
            );
            expect(hasInjection).toBe(true);
        });
    });

    describe("Event ID Tracking", () => {
        it("should track published event IDs to prevent duplicates", () => {
            // Add message without eventId (during execution)
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: 1,
                content: "My response",
                messageType: "text",
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

    describe("Multiple RALs", () => {
        it("should exclude other active RAL messages from buildMessagesForRal", async () => {
            // This test verifies that buildMessagesForRal excludes other active RAL messages
            // to avoid message duplication in the context.

            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Do multiple things",
                messageType: "text",
            });

            // RAL 1 starts and does some work
            const ral1 = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                content: "Working on task 1",
                messageType: "text",
            });
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "research",
                    input: { query: "important topic" },
                }] as ToolCallPart[],
            });

            // RAL 2 starts (RAL 1 still active)
            const ral2 = store.createRal(AGENT_PUBKEY);

            // Build messages for RAL 2
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            // Should include user message
            expect(messages.some(m => m.role === "user")).toBe(true);

            // Should NOT include RAL 1's messages directly (they're from another active RAL)
            const hasRal1Content = messages.some(m =>
                typeof m.content === "string" && m.content.includes("Working on task 1")
            );
            expect(hasRal1Content).toBe(false);
        });

        it("should include completed RAL messages directly", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "First request",
                messageType: "text",
            });

            // RAL 1 completes
            const ral1 = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                content: "Completed task 1",
                messageType: "text",
            });
            store.completeRal(AGENT_PUBKEY, ral1);

            // New user message
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Second request",
                messageType: "text",
            });

            // RAL 2 starts
            const ral2 = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            // Should include RAL 1's message directly (not summarized)
            expect(messages).toHaveLength(3);
            expect(messages[1].role).toBe("assistant");
            expect(messages[1].content).toContain("Completed task 1");

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
                content: "Hello",
                messageType: "text",
                eventId: "event-1",
            });

            const ral1 = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                content: "Hi there!",
                messageType: "text",
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
