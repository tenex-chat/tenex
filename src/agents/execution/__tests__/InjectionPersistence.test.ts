import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry } from "@/services/ral";
import type { ModelMessage } from "ai";

describe("Injection Persistence", () => {
    const agentPubkey = "agent-pubkey-123";
    const userPubkey = "user-pubkey-456";
    const conversationId = "conv-123";
    const projectId = "test-project";

    let store: ConversationStore;
    let ralRegistry: RALRegistry;

    beforeEach(() => {
        // Initialize ConversationStore with test project
        ConversationStore.initialize(`/test/${projectId}`, [agentPubkey]);
        store = ConversationStore.getOrLoad(conversationId);

        // Get RALRegistry instance
        ralRegistry = RALRegistry.getInstance();

        // Add initial user message
        store.addMessage({
            pubkey: userPubkey,
            content: "Write 10 poems",
            messageType: "text",
        });
    });

    afterEach(() => {
        // Clear stores between tests
        ConversationStore["stores"].clear();
        ralRegistry.clearAll();
    });

    describe("injection persists to ConversationStore", () => {
        it("should persist injection as a user message with the original user's pubkey", () => {
            // Create RAL
            const ralNumber = store.createRal(agentPubkey);

            // Simulate injection from ral_inject tool
            store.addMessage({
                pubkey: userPubkey,
                ral: ralNumber,
                content: "STOP. Write jokes instead of poems.",
                messageType: "text",
                targetedPubkeys: [agentPubkey],
            });

            // Verify it's in the store
            const messages = store.getAllMessages();
            const injectionMsg = messages.find(m => m.content.includes("jokes instead"));

            expect(injectionMsg).toBeDefined();
            expect(injectionMsg?.pubkey).toBe(userPubkey);
            expect(injectionMsg?.ral).toBe(ralNumber);
            expect(injectionMsg?.targetedPubkeys).toContain(agentPubkey);
        });

        it("should include injection in subsequent buildMessagesForRal calls", async () => {
            // Create RAL
            const ralNumber = store.createRal(agentPubkey);

            // Add some agent messages (simulating first step)
            store.addMessage({
                pubkey: agentPubkey,
                ral: ralNumber,
                content: "Writing poem 1...",
                messageType: "text",
            });

            // Build messages before injection
            const messagesBefore = await store.buildMessagesForRal(agentPubkey, ralNumber);
            const beforeCount = messagesBefore.length;

            // Add injection (simulating ral_inject being processed)
            store.addMessage({
                pubkey: userPubkey,
                ral: ralNumber,
                content: "STOP. Write jokes instead of poems.",
                messageType: "text",
                targetedPubkeys: [agentPubkey],
            });

            // Build messages after injection
            const messagesAfter = await store.buildMessagesForRal(agentPubkey, ralNumber);

            // Should have one more message
            expect(messagesAfter.length).toBe(beforeCount + 1);

            // The injection should be there as a user message
            const hasInjection = messagesAfter.some(
                m => typeof m.content === "string" && m.content.includes("jokes instead")
            );
            expect(hasInjection).toBe(true);
        });

        it("should maintain correct ordering with multiple injections at different steps", async () => {
            // Create RAL
            const ralNumber = store.createRal(agentPubkey);

            // Step 1: Agent writes poem 1
            store.addMessage({
                pubkey: agentPubkey,
                ral: ralNumber,
                content: "Writing poem 1...",
                messageType: "text",
            });

            // Step 2: Agent writes poem 2
            store.addMessage({
                pubkey: agentPubkey,
                ral: ralNumber,
                content: "Writing poem 2...",
                messageType: "text",
            });

            // First injection: Switch to jokes
            store.addMessage({
                pubkey: userPubkey,
                ral: ralNumber,
                content: "INJECTION 1: Switch to jokes",
                messageType: "text",
                targetedPubkeys: [agentPubkey],
            });

            // Step 3: Agent writes joke 1
            store.addMessage({
                pubkey: agentPubkey,
                ral: ralNumber,
                content: "Writing joke 1...",
                messageType: "text",
            });

            // Second injection: Make them funnier
            store.addMessage({
                pubkey: userPubkey,
                ral: ralNumber,
                content: "INJECTION 2: Make them funnier",
                messageType: "text",
                targetedPubkeys: [agentPubkey],
            });

            // Step 4: Agent writes funnier joke
            store.addMessage({
                pubkey: agentPubkey,
                ral: ralNumber,
                content: "Writing funnier joke...",
                messageType: "text",
            });

            // Build messages
            const messages = await store.buildMessagesForRal(agentPubkey, ralNumber);

            // Extract content from messages
            const contents = messages
                .filter(m => typeof m.content === "string")
                .map(m => m.content as string);

            // Verify ordering: poems -> injection1 -> joke -> injection2 -> funnier joke
            const poem1Idx = contents.findIndex(c => c.includes("poem 1"));
            const poem2Idx = contents.findIndex(c => c.includes("poem 2"));
            const injection1Idx = contents.findIndex(c => c.includes("INJECTION 1"));
            const joke1Idx = contents.findIndex(c => c.includes("joke 1"));
            const injection2Idx = contents.findIndex(c => c.includes("INJECTION 2"));
            const funnyJokeIdx = contents.findIndex(c => c.includes("funnier joke"));

            expect(poem1Idx).toBeLessThan(poem2Idx);
            expect(poem2Idx).toBeLessThan(injection1Idx);
            expect(injection1Idx).toBeLessThan(joke1Idx);
            expect(joke1Idx).toBeLessThan(injection2Idx);
            expect(injection2Idx).toBeLessThan(funnyJokeIdx);
        });

        it("should show injection as user role when building messages", async () => {
            // Create RAL
            const ralNumber = store.createRal(agentPubkey);

            // Add injection
            store.addMessage({
                pubkey: userPubkey,
                ral: ralNumber,
                content: "Switch to jokes",
                messageType: "text",
                targetedPubkeys: [agentPubkey],
            });

            // Build messages
            const messages = await store.buildMessagesForRal(agentPubkey, ralNumber);

            // Find the injection message
            const injectionMsg = messages.find(
                m => typeof m.content === "string" && m.content.includes("jokes")
            );

            expect(injectionMsg).toBeDefined();
            expect(injectionMsg?.role).toBe("user");
        });
    });

    describe("injection via RALRegistry flows to ConversationStore", () => {
        it("should queue injection in RALRegistry and consume it", () => {
            // Create RAL in registry
            const ralNumber = ralRegistry.create(agentPubkey, conversationId);

            // Queue an injection via injectToRAL (uses "system" role in registry)
            const success = ralRegistry.injectToRAL(
                agentPubkey,
                conversationId,
                ralNumber,
                "Switch to jokes"
            );
            expect(success).toBe(true);

            // Consume the injection
            const injections = ralRegistry.getAndConsumeInjections(
                agentPubkey,
                conversationId,
                ralNumber
            );

            expect(injections).toHaveLength(1);
            expect(injections[0].content).toBe("Switch to jokes");
            // RALRegistry uses "system" role, but when persisted to ConversationStore
            // it becomes a user message via the triggering event's pubkey
            expect(injections[0].role).toBe("system");

            // Should be empty on second call
            const injections2 = ralRegistry.getAndConsumeInjections(
                agentPubkey,
                conversationId,
                ralNumber
            );
            expect(injections2).toHaveLength(0);
        });
    });
});
