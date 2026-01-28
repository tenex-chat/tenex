/**
 * Tests for kind:1 event handling with ConversationStore integration
 *
 * Tests:
 * 1. kind:1 events hydrate ConversationStore
 * 2. Duplicate eventIds are skipped
 * 3. Conversation ID determined from e-tags
 * 4. User messages stored with correct pubkey
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock PubkeyService for attribution tests
mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName: async (pubkey: string) => {
            const names: Record<string, string> = {
                "user-pubkey-123": "User",
                "agent-pubkey-456": "Agent",
            };
            return names[pubkey] ?? "Unknown";
        },
    }),
}));

describe("kind:1 Event Handler with ConversationStore", () => {
    const TEST_DIR = "/tmp/tenex-kind1-handler-test";
    const PROJECT_ID = "test-project";
    const USER_PUBKEY = "user-pubkey-123";
    const AGENT_PUBKEY = "agent-pubkey-456";

    let store: ConversationStore;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
    });

    afterEach(async () => {
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    /**
     * Helper to create a mock kind:1 event
     */
    function createMockEvent(options: {
        id: string;
        pubkey: string;
        content: string;
        eTags?: string[];
    }): NDKEvent {
        const tags: string[][] = [];
        if (options.eTags) {
            for (const eTag of options.eTags) {
                tags.push(["e", eTag]);
            }
        }

        return {
            kind: 1,
            id: options.id,
            pubkey: options.pubkey,
            content: options.content,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            getMatchingTags: (tagName: string) => tags.filter(t => t[0] === tagName),
            tagValue: (tagName: string) => {
                const tag = tags.find(t => t[0] === tagName);
                return tag ? tag[1] : undefined;
            },
        } as unknown as NDKEvent;
    }

    describe("Event Hydration", () => {
        it("should hydrate kind:1 event into ConversationStore", () => {
            const conversationId = "conv-1";
            store.load(PROJECT_ID, conversationId);

            const event = createMockEvent({
                id: "event-1",
                pubkey: USER_PUBKEY,
                content: "Hello, help me with a task",
            });

            // Hydrate event into store
            store.addMessage({
                pubkey: event.pubkey,
                content: event.content,
                messageType: "text",
                eventId: event.id,
            });

            const messages = store.getAllMessages();
            expect(messages).toHaveLength(1);
            expect(messages[0].pubkey).toBe(USER_PUBKEY);
            expect(messages[0].messageType).toBe("text");
            expect(messages[0].content).toBe("Hello, help me with a task");
            expect(messages[0].eventId).toBe("event-1");
        });

        it("should hydrate agent response into store with RAL", () => {
            const conversationId = "conv-1";
            store.load(PROJECT_ID, conversationId);

            // First, add user message
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Hello",
                messageType: "text",
                eventId: "user-event-1",
            });

            // Create RAL for agent
            const ralNumber = store.createRal(AGENT_PUBKEY);

            // Add agent response
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "Hi there!",
                messageType: "text",
                eventId: "agent-event-1",
            });

            const messages = store.getAllMessages();
            expect(messages).toHaveLength(2);
            expect(messages[1].pubkey).toBe(AGENT_PUBKEY);
            expect(messages[1].ral).toBe(1);
            expect(messages[1].eventId).toBe("agent-event-1");
        });
    });

    describe("Duplicate Event Handling", () => {
        it("should detect duplicate events by eventId", () => {
            const conversationId = "conv-1";
            store.load(PROJECT_ID, conversationId);

            // Add first message
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Hello",
                messageType: "text",
                eventId: "event-1",
            });

            // Check for duplicate
            expect(store.hasEventId("event-1")).toBe(true);
            expect(store.hasEventId("event-2")).toBe(false);
        });

        it("should allow skipping duplicate events", () => {
            const conversationId = "conv-1";
            store.load(PROJECT_ID, conversationId);

            const event = createMockEvent({
                id: "event-1",
                pubkey: USER_PUBKEY,
                content: "Hello",
            });

            // First time: add message
            if (!store.hasEventId(event.id)) {
                store.addMessage({
                    pubkey: event.pubkey,
                    content: event.content,
                    messageType: "text",
                    eventId: event.id,
                });
            }

            // Second time: should skip (simulating our own event coming back)
            if (!store.hasEventId(event.id)) {
                store.addMessage({
                    pubkey: event.pubkey,
                    content: event.content,
                    messageType: "text",
                    eventId: event.id,
                });
            }

            // Only one message should be stored
            expect(store.getAllMessages()).toHaveLength(1);
        });
    });

    describe("Persistence Across Restarts", () => {
        it("should persist and restore conversation state", async () => {
            const conversationId = "conv-persist";
            store.load(PROJECT_ID, conversationId);

            // Add messages
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Hello",
                messageType: "text",
                eventId: "event-1",
            });

            const ralNumber = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "Hi there!",
                messageType: "text",
                eventId: "event-2",
            });

            await store.save();

            // Create new store and load
            const store2 = new ConversationStore(TEST_DIR);
            store2.load(PROJECT_ID, conversationId);

            // Verify messages restored
            expect(store2.getAllMessages()).toHaveLength(2);
            expect(store2.hasEventId("event-1")).toBe(true);
            expect(store2.hasEventId("event-2")).toBe(true);

            // Verify RAL state restored
            expect(store2.isRalActive(AGENT_PUBKEY, ralNumber)).toBe(true);
        });
    });

    // Message building after hydration test removed: attribution prefixes are no longer added
    // for normal messages, only for unexpected senders via senderPubkey.
});
