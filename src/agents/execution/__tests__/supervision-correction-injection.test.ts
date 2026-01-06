/**
 * Tests for supervision correction message injection
 *
 * Verifies that when supervision detects a violation and queues a correction
 * message, that message is properly included in the agent's messages array
 * when the agent is re-run.
 *
 * Bug being fixed: Correction messages were queued to RALRegistry.queuedInjections
 * but only consumed in prepareStep (mid-loop). This meant the INITIAL message
 * building in executeStreaming didn't include the correction message.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm } from "fs/promises";

// Mock PubkeyService for attribution tests
mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName: async (pubkey: string) => {
            const names: Record<string, string> = {
                "user-pubkey-456": "User",
                "agent-pubkey-123": "TestAgent",
            };
            return names[pubkey] ?? pubkey.substring(0, 8);
        },
    }),
}));

import { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry } from "@/services/ral/RALRegistry";

describe("Supervision Correction Message Injection", () => {
    const TEST_DIR = "/tmp/tenex-supervision-injection-test";
    const PROJECT_ID = "test-project";
    const CONVERSATION_ID = "conv-supervision";
    const AGENT_PUBKEY = "agent-pubkey-123";
    const USER_PUBKEY = "user-pubkey-456";

    let store: ConversationStore;
    let registry: RALRegistry;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, CONVERSATION_ID);
        registry = RALRegistry.getInstance();
        registry.clear(AGENT_PUBKEY, CONVERSATION_ID);
    });

    afterEach(async () => {
        registry.clear(AGENT_PUBKEY, CONVERSATION_ID);
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    describe("correction message should be included in initial message build", () => {
        /**
         * This test reproduces the bug where the correction message is queued
         * but not included in the initial messages built for the re-run.
         *
         * Expected flow:
         * 1. User sends message
         * 2. Agent runs and completes (but with a violation)
         * 3. Supervisor detects violation and queues correction message
         * 4. Agent is re-run
         * 5. Correction message should be in the agent's messages
         */
        it("should include queued correction message when building messages for re-run", async () => {
            // Step 1: User sends initial message
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Please take a screenshot and embed it in your response",
                messageType: "text",
                eventId: "user-event-1",
            });

            // Step 2: Agent starts first RAL and produces output (with tool calls)
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);
            store.ensureRalActive(AGENT_PUBKEY, ralNumber);

            // Agent's tool calls and text response (simulating first run)
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "I'll take a screenshot for you.",
                messageType: "text",
            });

            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call" as const,
                    toolCallId: "call_screenshot",
                    toolName: "take_screenshot",
                    input: {},
                }],
            });

            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "",
                messageType: "tool-result",
                toolData: [{
                    type: "tool-result" as const,
                    toolCallId: "call_screenshot",
                    toolName: "take_screenshot",
                    output: { type: "text" as const, value: "Screenshot saved to /tmp/screenshot.png" },
                }],
            });

            // Agent's final response (missing the embedded screenshot)
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "Done! I took the screenshot.",
                messageType: "text",
            });

            // Step 3: Supervisor detects violation and queues correction message
            // This simulates what happens in AgentExecutor.ts lines 697-704
            const correctionMessage = `You successfully launched the app and took a screenshot. However, you failed to upload the screenshot and embed it in your response as per Lesson #5: "Embed screenshots in markdown responses". Please upload the screenshot using upload_blob and then embed the returned URL in a markdown response.`;

            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                correctionMessage
            );

            // Verify the message is in the queue
            const state = registry.getRAL(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect(state?.queuedInjections).toHaveLength(1);
            expect(state?.queuedInjections[0].content).toBe(correctionMessage);

            // Step 4: Simulate re-run - this is where the bug occurs
            // In the buggy code, buildMessagesForRal is called BEFORE consuming injections
            // So the correction message wouldn't be included

            // First, let's see what messages look like WITHOUT consuming injections (the bug)
            const messagesWithoutInjection = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);

            // The correction message should NOT be in the messages yet (demonstrating the bug state)
            const hasCorrection = messagesWithoutInjection.some(m =>
                typeof m.content === "string" && m.content.includes("Lesson #5")
            );
            expect(hasCorrection).toBe(false); // Bug: correction not included

            // Step 5: Now consume injections and persist them to ConversationStore
            // This is what needs to happen BEFORE building messages
            const injections = registry.getAndConsumeInjections(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect(injections).toHaveLength(1);

            for (const injection of injections) {
                store.addMessage({
                    pubkey: USER_PUBKEY, // Correction appears as user message
                    ral: ralNumber,
                    content: injection.content,
                    messageType: "text",
                    targetedPubkeys: [AGENT_PUBKEY],
                });
            }

            // Step 6: Now build messages - should include correction
            const messagesWithInjection = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);

            // Verify correction message IS now included
            const hasCorrectionNow = messagesWithInjection.some(m =>
                typeof m.content === "string" && m.content.includes("Lesson #5")
            );
            expect(hasCorrectionNow).toBe(true);

            // Verify the correction message appears AFTER the agent's last message
            const lastMessageContent = messagesWithInjection[messagesWithInjection.length - 1].content;
            expect(typeof lastMessageContent).toBe("string");
            expect(lastMessageContent as string).toContain("Lesson #5");
        });

        it("should consume and persist injections before initial message build", async () => {
            // This test verifies the FIX behavior:
            // Injections should be consumed and persisted to ConversationStore
            // BEFORE buildMessagesForRal is called

            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Do something",
                messageType: "text",
            });

            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);
            store.ensureRalActive(AGENT_PUBKEY, ralNumber);

            // Agent's first response
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "Here's my incomplete response.",
                messageType: "text",
            });

            // Queue a correction
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "Please complete your response properly."
            );

            // THE FIX: Consume and persist injections BEFORE building messages
            // This is the order that should happen in executeStreaming
            const pendingInjections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );

            // Persist to ConversationStore
            for (const injection of pendingInjections) {
                store.addMessage({
                    pubkey: USER_PUBKEY,
                    ral: ralNumber,
                    content: injection.content,
                    messageType: "text",
                    targetedPubkeys: [AGENT_PUBKEY],
                });
            }

            // NOW build messages - should include the correction
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);

            // Should have: user request, agent response, correction
            expect(messages.length).toBeGreaterThanOrEqual(3);

            // Last message should be the correction (targeted to agent, so role=user)
            const lastMessage = messages[messages.length - 1];
            expect(lastMessage.role).toBe("user");
            expect(lastMessage.content).toContain("complete your response properly");
        });

        it("should handle multiple queued injections", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Do multiple things",
                messageType: "text",
            });

            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);
            store.ensureRalActive(AGENT_PUBKEY, ralNumber);

            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "Working on it...",
                messageType: "text",
            });

            // Queue multiple corrections
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "First correction: fix issue A"
            );
            registry.queueSystemMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "System notice: additional context"
            );

            // Consume all and persist
            const injections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );

            expect(injections).toHaveLength(2);

            for (const injection of injections) {
                store.addMessage({
                    pubkey: USER_PUBKEY,
                    ral: ralNumber,
                    content: injection.content,
                    messageType: "text",
                    targetedPubkeys: [AGENT_PUBKEY],
                });
            }

            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);

            // Both injections should be present
            const contents = messages.map(m => m.content).join(" ");
            expect(contents).toContain("First correction");
            expect(contents).toContain("additional context");
        });

        it("should work correctly when no injections are queued", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Simple request",
                messageType: "text",
            });

            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);
            store.ensureRalActive(AGENT_PUBKEY, ralNumber);

            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "Perfect response.",
                messageType: "text",
            });

            // No injections queued - just verify it doesn't break
            const injections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );

            expect(injections).toHaveLength(0);

            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);

            // Should just have user + agent messages
            expect(messages).toHaveLength(2);
        });
    });
});
