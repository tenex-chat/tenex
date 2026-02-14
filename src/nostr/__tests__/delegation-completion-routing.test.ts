import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { ConversationStore } from "@/conversations/ConversationStore";
import { AgentEventEncoder } from "../AgentEventEncoder";
import type { EventContext } from "../types";

// Mock PubkeyService
mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName: async () => "User",
        getNameSync: () => "User",
    }),
}));

// Mock NDK client
mock.module("../ndkClient", () => ({
    getNDK: mock(() => ({})),
}));

// Mock project context
mock.module("@/services/projects", () => ({
    getProjectContext: mock(() => ({
        project: {
            tagReference: () => ["a", "31933:pubkey:d-tag"],
            pubkey: "project-owner-pubkey",
        },
        agentRegistry: {
            getAgentByPubkey: () => null,
        },
    })),
}));

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

/**
 * Delegation Completion Routing Tests
 *
 * These tests verify that completion events are correctly routed back up the
 * delegation chain, even when:
 * 1. RAL state is lost (e.g., process restart)
 * 2. The triggering event comes from a human responding to an "ask"
 * 3. Hours pass between ask and response
 *
 * The key invariant: completions should p-tag the IMMEDIATE DELEGATOR
 * (second-to-last entry in delegation chain), not the triggeringEvent.pubkey.
 */
describe("Delegation Completion Routing", () => {
    const TEST_DIR = "/tmp/tenex-delegation-routing-test";
    const PROJECT_ID = "test-project";

    // Test pubkeys
    const USER_PUBKEY = "user-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const ARCHITECT_PUBKEY = "arch-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd";
    const EXEC_COORD_PUBKEY = "exec-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd";
    const CLAUDE_CODE_PUBKEY = "claude-pubkey-234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        ConversationStore.initialize(TEST_DIR);
    });

    afterEach(async () => {
        ConversationStore.reset();
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    describe("Completion p-tag routing", () => {
        it("should route completion to immediate delegator when delegation chain exists", async () => {
            const encoder = new AgentEventEncoder();
            const conversationId = "conv-delegation-chain-test";

            // Create a conversation store with a delegation chain
            // Use getOrLoad to ensure it's registered with the registry
            const store = ConversationStore.getOrLoad(conversationId);

            // Add a message so the store is persisted (required for registry lookup)
            store.addMessage({
                pubkey: EXEC_COORD_PUBKEY,
                content: "Please do the task",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });

            // Set up delegation chain: User -> architect -> exec-coord -> claude-code
            // claude-code is the current agent (last entry)
            // exec-coord is the immediate delegator (second-to-last)
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                    { pubkey: ARCHITECT_PUBKEY, displayName: "architect-orchestrator", isUser: false, conversationId: "conv-1" },
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "execution-coordinator", isUser: false, conversationId: "conv-2" },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false, conversationId: conversationId },
                ],
            });

            // Save to disk so registry can find it
            await store.save();

            // Simulate the bug scenario: triggeringEvent is from the USER
            // (e.g., user responded to an "ask" hours later, RAL was cleared)
            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY; // User's response!
            mockTriggeringEvent.id = "user-response-event-id";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: conversationId },
                conversationId: conversationId,
                ralNumber: 1,
            };

            // Encode completion
            const completionEvent = encoder.encodeCompletion(
                { content: "Task completed" },
                context
            );

            // Verify p-tag routes to exec-coord (immediate delegator), NOT user
            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag).toBeDefined();
            expect(pTag?.[1]).toBe(EXEC_COORD_PUBKEY);
            expect(pTag?.[1]).not.toBe(USER_PUBKEY);
        });

        it("should route completion to triggeringEvent.pubkey when no delegation chain", async () => {
            const encoder = new AgentEventEncoder();
            const conversationId = "conv-no-chain-test";

            // Create a conversation store WITHOUT a delegation chain (direct user conversation)
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Direct message",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            await store.save();
            // No delegation chain metadata set

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY;
            mockTriggeringEvent.id = "direct-user-event";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: conversationId },
                conversationId: conversationId,
                ralNumber: 1,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Direct response to user" },
                context
            );

            // Should fall back to triggeringEvent.pubkey
            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag).toBeDefined();
            expect(pTag?.[1]).toBe(USER_PUBKEY);
        });

        it("should route completion to triggeringEvent.pubkey when chain has only one entry", async () => {
            const encoder = new AgentEventEncoder();
            const conversationId = "conv-single-entry-test";

            // Create a conversation store with a single-entry delegation chain
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Single entry chain message",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                ],
            });
            await store.save();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY;
            mockTriggeringEvent.id = "user-event";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: conversationId },
                conversationId: conversationId,
                ralNumber: 1,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Response" },
                context
            );

            // Should fall back to triggeringEvent.pubkey (chain too short)
            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag?.[1]).toBe(USER_PUBKEY);
        });

        it("should work correctly with 2-entry chain (direct delegation)", async () => {
            const encoder = new AgentEventEncoder();
            const conversationId = "conv-two-entry-test";

            // User -> claude-code (direct delegation, no intermediaries)
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Direct delegation",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false, conversationId: conversationId },
                ],
            });
            await store.save();

            // Simulate triggeringEvent from some other source (shouldn't matter)
            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "random-pubkey";
            mockTriggeringEvent.id = "random-event";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: conversationId },
                conversationId: conversationId,
                ralNumber: 1,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Direct delegation response" },
                context
            );

            // Should route to USER (second-to-last = first entry)
            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag?.[1]).toBe(USER_PUBKEY);
        });

        it("should fall back to triggeringEvent when conversation store not found", () => {
            const encoder = new AgentEventEncoder();

            // Use a conversation ID that doesn't exist in store
            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = ARCHITECT_PUBKEY;
            mockTriggeringEvent.id = "orphan-event";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "nonexistent-conv" },
                conversationId: "nonexistent-conv",
                ralNumber: 1,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Response without store" },
                context
            );

            // Should fall back to triggeringEvent.pubkey
            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag?.[1]).toBe(ARCHITECT_PUBKEY);
        });
    });

    describe("Ask tool scenario (the original bug)", () => {
        it("should route completion correctly after daemon restart", async () => {
            const encoder = new AgentEventEncoder();
            const conversationId = "conv-ask-scenario";

            // Simulate the full scenario:
            // 1. exec-coord delegates to claude-code
            // 2. claude-code uses "ask" tool to ask user a question
            // 3. DAEMON RESTARTS - RAL state is lost (in-memory Map cleared)
            // 4. User responds - this becomes the triggeringEvent
            // 5. claude-code completes - completion should still route to exec-coord!
            //
            // Key insight: The delegation chain metadata IS persisted (stored in conversation
            // JSON on disk / Nostr), while RAL state is in-memory only.

            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: EXEC_COORD_PUBKEY,
                content: "Delegation to claude-code",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });

            // The delegation chain remains persisted even after RAL state clears
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                    { pubkey: ARCHITECT_PUBKEY, displayName: "architect-orchestrator", isUser: false, conversationId: "conv-arch" },
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "execution-coordinator", isUser: false, conversationId: "conv-exec" },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false, conversationId: conversationId },
                ],
            });
            await store.save();

            // The bug: triggeringEvent is from the user responding to the ask
            // OLD behavior: completion would p-tag USER (wrong!)
            // NEW behavior: completion should p-tag EXEC_COORD (correct!)
            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY; // User's response to the ask!
            mockTriggeringEvent.id = "user-ask-response";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: conversationId },
                conversationId: conversationId,
                ralNumber: 1,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Based on your answer, I've completed the task" },
                context
            );

            // Critical assertion: completion routes to exec-coord, NOT user
            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag).toBeDefined();
            expect(pTag?.[1]).toBe(EXEC_COORD_PUBKEY);
            expect(pTag?.[1]).not.toBe(USER_PUBKEY);

            // Also verify status tag is present
            const statusTag = completionEvent.tags.find((t) => t[0] === "status");
            expect(statusTag?.[1]).toBe("completed");
        });
    });

    describe("Error event routing (should match completion)", () => {
        it("should route errors to triggeringEvent.pubkey (errors don't use delegation chain)", async () => {
            const encoder = new AgentEventEncoder();
            const conversationId = "conv-error-test";

            // Create store with delegation chain
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: EXEC_COORD_PUBKEY,
                content: "Task",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "execution-coordinator", isUser: false, conversationId: "conv-exec" },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false, conversationId: conversationId },
                ],
            });
            await store.save();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY;
            mockTriggeringEvent.id = "error-trigger";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: conversationId },
                conversationId: conversationId,
                ralNumber: 1,
            };

            // Note: encodeError still uses triggeringEvent.pubkey
            // This is intentional - error events may have different routing requirements
            const errorEvent = encoder.encodeError(
                { message: "An error occurred", errorType: "test" },
                context
            );

            const pTag = errorEvent.tags.find((t) => t[0] === "p");
            expect(pTag?.[1]).toBe(USER_PUBKEY);
        });
    });
});
