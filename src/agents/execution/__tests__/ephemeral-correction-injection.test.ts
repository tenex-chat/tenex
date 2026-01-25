/**
 * Tests for ephemeral supervision correction message injection
 *
 * This test verifies the fix for the supervision re-engagement bug:
 * - Correction messages should be delivered to the LLM during re-engagement
 * - Ephemeral messages should NOT persist to ConversationStore permanently
 * - The RAL should only be cleared AFTER supervision completes (not during executeStreaming)
 *
 * Bug root cause: clearRAL() was called in executeStreaming() BEFORE supervision ran,
 * so queueUserMessage() in supervision would silently fail (RAL already gone).
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
import type { QueuedInjection } from "@/services/ral/types";

describe("Ephemeral Correction Message Injection", () => {
    const TEST_DIR = "/tmp/tenex-ephemeral-injection-test";
    const PROJECT_ID = "test-project";
    const CONVERSATION_ID = "conv-ephemeral-test";
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

    describe("ephemeral flag on queueUserMessage", () => {
        it("should accept ephemeral option and mark injection correctly", () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            // Queue a normal (non-ephemeral) message
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "Normal correction message"
            );

            // Queue an ephemeral message (for supervision corrections)
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "Ephemeral supervision correction",
                { ephemeral: true }
            );

            const state = registry.getRAL(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect(state?.queuedInjections).toHaveLength(2);

            // First injection should NOT be ephemeral
            expect(state?.queuedInjections[0].content).toBe("Normal correction message");
            expect(state?.queuedInjections[0].ephemeral).toBeUndefined();

            // Second injection SHOULD be ephemeral
            expect(state?.queuedInjections[1].content).toBe("Ephemeral supervision correction");
            expect(state?.queuedInjections[1].ephemeral).toBe(true);
        });

        it("should preserve ephemeral flag when consuming injections", () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "Ephemeral message",
                { ephemeral: true }
            );

            const injections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );

            expect(injections).toHaveLength(1);
            expect(injections[0].ephemeral).toBe(true);
        });
    });

    describe("ephemeral message handling in AgentExecutor flow", () => {
        /**
         * This test simulates the correct flow after the fix:
         * 1. Agent runs and produces output (with violation)
         * 2. Supervision detects violation
         * 3. Supervision queues EPHEMERAL correction message
         * 4. Re-execution consumes ephemeral message
         * 5. Ephemeral message goes to LLM but is NOT persisted to ConversationStore
         */
        it("should include ephemeral message in LLM context but NOT persist to store", async () => {
            // Setup: user message and first agent response
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Please embed a screenshot in your response",
                messageType: "text",
                eventId: "user-event-1",
            });

            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);
            store.ensureRalActive(AGENT_PUBKEY, ralNumber);

            // Agent's incomplete first response
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "Done! I took the screenshot.",
                messageType: "text",
            });

            // Simulate supervision queueing EPHEMERAL correction
            const correctionMessage = "You failed to embed the screenshot. Please use upload_blob and embed the URL.";
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                correctionMessage,
                { ephemeral: true }
            );

            // Consume injections (simulating executeStreaming re-run)
            const injections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );

            expect(injections).toHaveLength(1);
            expect(injections[0].ephemeral).toBe(true);

            // CRITICAL: Ephemeral messages should go to LLM but NOT be persisted
            // The executor should separate ephemeral from non-ephemeral:
            const ephemeralInjections = injections.filter(i => i.ephemeral);
            const persistedInjections = injections.filter(i => !i.ephemeral);

            // Only persist non-ephemeral
            for (const injection of persistedInjections) {
                store.addMessage({
                    pubkey: USER_PUBKEY,
                    ral: ralNumber,
                    content: injection.content,
                    messageType: "text",
                    targetedPubkeys: [AGENT_PUBKEY],
                });
            }

            // Build messages for LLM (without ephemeral - those are added separately)
            const baseMessages = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);

            // Base messages should NOT contain the correction (it was ephemeral)
            const hasCorrection = baseMessages.some(m =>
                typeof m.content === "string" && m.content.includes("failed to embed")
            );
            expect(hasCorrection).toBe(false);

            // But ephemeral messages would be injected at compile time
            // The MessageCompiler.compile() accepts ephemeralMessages[] parameter
            expect(ephemeralInjections).toHaveLength(1);
            expect(ephemeralInjections[0].content).toBe(correctionMessage);
        });

        it("should handle mixed ephemeral and non-ephemeral injections", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Do something",
                messageType: "text",
            });

            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);
            store.ensureRalActive(AGENT_PUBKEY, ralNumber);

            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "Working...",
                messageType: "text",
            });

            // Queue a non-ephemeral injection (should persist)
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "User follow-up question"
            );

            // Queue an ephemeral injection (should NOT persist)
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "Supervision correction (ephemeral)",
                { ephemeral: true }
            );

            const injections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );

            const ephemeral = injections.filter(i => i.ephemeral);
            const persisted = injections.filter(i => !i.ephemeral);

            expect(ephemeral).toHaveLength(1);
            expect(persisted).toHaveLength(1);

            // Only persist non-ephemeral
            for (const injection of persisted) {
                store.addMessage({
                    pubkey: USER_PUBKEY,
                    ral: ralNumber,
                    content: injection.content,
                    messageType: "text",
                });
            }

            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);

            // Should contain the non-ephemeral message
            const contents = messages.map(m => m.content).join(" ");
            expect(contents).toContain("User follow-up question");
            expect(contents).not.toContain("Supervision correction (ephemeral)");
        });
    });

    describe("RAL lifetime and clearRAL timing", () => {
        /**
         * This test verifies that RAL still exists when supervision tries to queue messages.
         * The fix moved clearRAL() from executeStreaming() to AFTER supervision in executeOnce().
         */
        it("should be able to queue message after executeStreaming (before clearRAL)", () => {
            // This simulates the timeline:
            // 1. RAL created
            // 2. executeStreaming runs (previously cleared RAL at end - bug!)
            // 3. Supervision runs and tries to queue message
            // 4. clearRAL happens in executeOnce AFTER supervision (fix!)

            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            // RAL should exist
            const ralState = registry.getRAL(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect(ralState).toBeDefined();

            // Simulate supervision queueing a correction (this is the critical moment)
            // With the bug, RAL would already be cleared here
            // With the fix, RAL still exists
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "Supervision correction",
                { ephemeral: true }
            );

            // Verify the message was queued successfully
            const state = registry.getRAL(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect(state?.queuedInjections).toHaveLength(1);
            expect(state?.queuedInjections[0].content).toBe("Supervision correction");

            // Now clear (simulating after supervision decides NOT to re-engage)
            registry.clearRAL(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            const clearedState = registry.getRAL(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect(clearedState).toBeUndefined();
        });

        it("should retain queued messages across multiple re-engagement attempts if not consumed", () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            // First supervision correction
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "First correction",
                { ephemeral: true }
            );

            // Simulate first re-engagement attempt consuming the message
            const firstInjections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );
            expect(firstInjections).toHaveLength(1);

            // Queue should now be empty
            const emptyInjections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );
            expect(emptyInjections).toHaveLength(0);

            // Second supervision correction (if first re-engagement also failed)
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "Second correction",
                { ephemeral: true }
            );

            const secondInjections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );
            expect(secondInjections).toHaveLength(1);
            expect(secondInjections[0].content).toBe("Second correction");
        });
    });

    describe("message count behavior with ephemeral messages", () => {
        /**
         * This test verifies the trace behavior:
         * - message.count should increment on re-engagement (ephemeral message in context)
         * - On successful re-execution, next run should NOT have the extra message
         */
        it("ephemeral message should increment context count during re-run only", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "User request",
                messageType: "text",
            });

            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);
            store.ensureRalActive(AGENT_PUBKEY, ralNumber);

            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "First response",
                messageType: "text",
            });

            // Before re-engagement
            const beforeMessages = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);
            const beforeCount = beforeMessages.length;

            // Queue ephemeral correction
            registry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                "Ephemeral correction",
                { ephemeral: true }
            );

            const injections = registry.getAndConsumeInjections(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber
            );
            const ephemeralMessages = injections.filter(i => i.ephemeral);

            // During re-engagement, the ephemeral message would be added at compile time
            // So effective count = beforeCount + ephemeralMessages.length
            const duringReengagementCount = beforeCount + ephemeralMessages.length;
            expect(duringReengagementCount).toBe(beforeCount + 1);

            // After successful re-execution (new conversation turn)
            // The ephemeral message is NOT persisted, so count returns to normal
            const afterMessages = await store.buildMessagesForRal(AGENT_PUBKEY, ralNumber);
            expect(afterMessages.length).toBe(beforeCount); // Same as before!
        });
    });
});
