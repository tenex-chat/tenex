import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
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
 * These tests verify that completion events are correctly routed based on
 * the completionRecipientPubkey field in EventContext. This field is pre-resolved
 * by createEventContext() from the delegation chain stored in ConversationStore.
 *
 * Architecture (layer-aware):
 * - createEventContext() (layer 3, in services/event-context/) looks up the delegation
 *   chain from ConversationStore and resolves the immediate delegator pubkey
 * - The resolved pubkey is set in EventContext.completionRecipientPubkey
 * - EventContext is passed to layer 2 code (nostr/) with the pre-resolved pubkey
 * - AgentEventEncoder (layer 2) uses the pre-resolved pubkey for the completion p-tag
 *
 * This layered approach avoids layer violations - layer 2 code (nostr/) cannot
 * import layer 3 code (conversations/, services/).
 */
describe("Delegation Completion Routing", () => {
    const TEST_DIR = "/tmp/tenex-delegation-routing-test";

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

    describe("Encoder completion p-tag routing (unit tests)", () => {
        it("should use completionRecipientPubkey when provided", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY; // triggeringEvent is from user
            mockTriggeringEvent.id = "user-event";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "conv-test" },
                conversationId: "conv-test",
                ralNumber: 1,
                completionRecipientPubkey: EXEC_COORD_PUBKEY, // Pre-resolved by createEventContext
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Task completed" },
                context
            );

            // Should use pre-resolved recipient, NOT triggeringEvent.pubkey
            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag?.[1]).toBe(EXEC_COORD_PUBKEY);
            expect(pTag?.[1]).not.toBe(USER_PUBKEY);
        });

        it("should fall back to triggeringEvent.pubkey when completionRecipientPubkey is not set", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY;
            mockTriggeringEvent.id = "direct-user-event";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "conv-direct" },
                conversationId: "conv-direct",
                ralNumber: 1,
                // No completionRecipientPubkey - direct conversation
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Direct response to user" },
                context
            );

            // Should fall back to triggeringEvent.pubkey
            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag?.[1]).toBe(USER_PUBKEY);
        });

        it("should fall back to triggeringEvent.pubkey when completionRecipientPubkey is undefined", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = ARCHITECT_PUBKEY;
            mockTriggeringEvent.id = "architect-event";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "conv-fallback" },
                conversationId: "conv-fallback",
                ralNumber: 1,
                completionRecipientPubkey: undefined,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Response" },
                context
            );

            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag?.[1]).toBe(ARCHITECT_PUBKEY);
        });

        it("should include status=completed tag on completion events", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY;
            mockTriggeringEvent.id = "test-event";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "conv-status" },
                conversationId: "conv-status",
                ralNumber: 1,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Done" },
                context
            );

            const statusTag = completionEvent.tags.find((t) => t[0] === "status");
            expect(statusTag?.[1]).toBe("completed");
        });
    });

    describe("Delegation chain resolution (simulating createEventContext behavior)", () => {
        /**
         * These tests verify the delegation chain resolution logic that createEventContext()
         * performs before creating the EventContext. We manually simulate what
         * resolveCompletionRecipient() (in services/event-context/) does.
         */

        const resolveImmediateDelegator = (
            delegationChain: { pubkey: string }[] | undefined
        ): string | undefined => {
            if (delegationChain && delegationChain.length >= 2) {
                return delegationChain[delegationChain.length - 2].pubkey;
            }
            return undefined;
        };

        it("should resolve immediate delegator from 4-entry chain", async () => {
            const conversationId = "conv-4-entry";

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
                    { pubkey: ARCHITECT_PUBKEY, displayName: "architect", isUser: false, conversationId: "conv-1" },
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "exec-coord", isUser: false, conversationId: "conv-2" },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false, conversationId: conversationId },
                ],
            });
            await store.save();

            const loadedStore = ConversationStore.get(conversationId);
            const recipient = resolveImmediateDelegator(loadedStore?.metadata?.delegationChain);

            expect(recipient).toBe(EXEC_COORD_PUBKEY);
        });

        it("should resolve user from 2-entry chain (direct delegation)", async () => {
            const conversationId = "conv-2-entry";

            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Direct task",
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

            const loadedStore = ConversationStore.get(conversationId);
            const recipient = resolveImmediateDelegator(loadedStore?.metadata?.delegationChain);

            expect(recipient).toBe(USER_PUBKEY);
        });

        it("should return undefined for 1-entry chain", async () => {
            const conversationId = "conv-1-entry";

            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Message",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                ],
            });
            await store.save();

            const loadedStore = ConversationStore.get(conversationId);
            const recipient = resolveImmediateDelegator(loadedStore?.metadata?.delegationChain);

            expect(recipient).toBeUndefined();
        });

        it("should return undefined when no delegation chain exists", async () => {
            const conversationId = "conv-no-chain";

            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Direct message",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            await store.save();
            // No delegation chain metadata

            const loadedStore = ConversationStore.get(conversationId);
            const recipient = resolveImmediateDelegator(loadedStore?.metadata?.delegationChain);

            expect(recipient).toBeUndefined();
        });

        it("should return undefined when conversation store not found", () => {
            const recipient = resolveImmediateDelegator(undefined);
            expect(recipient).toBeUndefined();
        });
    });

    describe("Delegation chain persistence (daemon restart simulation)", () => {
        it("should preserve delegation chain across store reset and reload", async () => {
            const conversationId = "conv-persistence-test";

            // Phase 1: Create and persist the delegation chain
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: EXEC_COORD_PUBKEY,
                content: "Delegation to claude-code",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                    { pubkey: ARCHITECT_PUBKEY, displayName: "architect-orchestrator", isUser: false, conversationId: "conv-arch" },
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "execution-coordinator", isUser: false, conversationId: "conv-exec" },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false, conversationId: conversationId },
                ],
            });
            await store.save();

            // Phase 2: SIMULATE DAEMON RESTART - reset the in-memory registry
            // This clears all in-memory state, forcing reload from disk
            ConversationStore.reset();
            ConversationStore.initialize(TEST_DIR);

            // Phase 3: Verify the delegation chain was loaded from disk
            const reloadedStore = ConversationStore.getOrLoad(conversationId);
            const delegationChain = reloadedStore.metadata?.delegationChain;

            expect(delegationChain).toBeDefined();
            expect(delegationChain?.length).toBe(4);
            expect(delegationChain?.[0].pubkey).toBe(USER_PUBKEY);
            expect(delegationChain?.[0].displayName).toBe("Pablo");
            expect(delegationChain?.[1].pubkey).toBe(ARCHITECT_PUBKEY);
            expect(delegationChain?.[2].pubkey).toBe(EXEC_COORD_PUBKEY);
            expect(delegationChain?.[2].displayName).toBe("execution-coordinator");
            expect(delegationChain?.[3].pubkey).toBe(CLAUDE_CODE_PUBKEY);
        });

        it("should route completion correctly after reload using persisted chain", async () => {
            const conversationId = "conv-reload-routing";

            // Phase 1: Set up and persist
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
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "exec-coord", isUser: false, conversationId: "conv-exec" },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false, conversationId: conversationId },
                ],
            });
            await store.save();

            // Phase 2: Reset (daemon restart)
            ConversationStore.reset();
            ConversationStore.initialize(TEST_DIR);

            // Phase 3: Reload and resolve recipient (simulating AgentPublisher)
            const reloadedStore = ConversationStore.getOrLoad(conversationId);
            const delegationChain = reloadedStore.metadata?.delegationChain;
            const immediateDelegatorPubkey = delegationChain?.[delegationChain.length - 2]?.pubkey;

            expect(immediateDelegatorPubkey).toBe(EXEC_COORD_PUBKEY);

            // Phase 4: Encode completion with pre-resolved recipient
            const encoder = new AgentEventEncoder();
            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY; // User's response (not the delegator!)
            mockTriggeringEvent.id = "user-response-after-restart";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: conversationId },
                conversationId: conversationId,
                ralNumber: 1,
                completionRecipientPubkey: immediateDelegatorPubkey,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Task completed after daemon restart" },
                context
            );

            // Critical: routes to exec-coord (from persisted chain), NOT to user
            const pTag = completionEvent.tags.find((t) => t[0] === "p");
            expect(pTag?.[1]).toBe(EXEC_COORD_PUBKEY);
            expect(pTag?.[1]).not.toBe(USER_PUBKEY);
        });
    });

    describe("Error event routing (unchanged behavior)", () => {
        it("should route errors to triggeringEvent.pubkey (errors don't use delegation chain)", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = USER_PUBKEY;
            mockTriggeringEvent.id = "error-trigger";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "conv-error" },
                conversationId: "conv-error",
                ralNumber: 1,
                // Even if completionRecipientPubkey is set, errors use triggeringEvent.pubkey
                completionRecipientPubkey: EXEC_COORD_PUBKEY,
            };

            // Note: encodeError always uses triggeringEvent.pubkey
            const errorEvent = encoder.encodeError(
                { message: "An error occurred", errorType: "test" },
                context
            );

            const pTag = errorEvent.tags.find((t) => t[0] === "p");
            expect(pTag?.[1]).toBe(USER_PUBKEY);
        });
    });
});
