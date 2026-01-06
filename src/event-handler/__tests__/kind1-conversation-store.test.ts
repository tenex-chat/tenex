/**
 * Tests for kind:1 event handling with ConversationStore integration
 *
 * Tests:
 * 1. kind:1 events hydrate ConversationStore
 * 2. Duplicate eventIds are skipped
 * 3. Conversation ID determined from e-tags
 * 4. User messages stored with correct pubkey
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

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

    describe("Conversation ID Determination", () => {
        it("should use event ID as conversation ID when no e-tags", () => {
            const event = createMockEvent({
                id: "event-1",
                pubkey: USER_PUBKEY,
                content: "Hello",
            });

            // No e-tags means this event IS the root
            const conversationId = event.getMatchingTags("e").length === 0
                ? event.id
                : event.getMatchingTags("e")[0][1];

            expect(conversationId).toBe("event-1");
        });

        it("should use first e-tag as conversation ID when e-tags present", () => {
            const event = createMockEvent({
                id: "event-2",
                pubkey: USER_PUBKEY,
                content: "Reply",
                eTags: ["root-event-id", "some-other-tag"],
            });

            const eTags = event.getMatchingTags("e");
            const conversationId = eTags.length === 0
                ? event.id
                : eTags[0][1];

            expect(conversationId).toBe("root-event-id");
        });
    });

    describe("Event Hydration to ConversationStore", () => {
        it("should hydrate user message into store", () => {
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
                message: { role: "user", content: event.content },
                eventId: event.id,
            });

            const messages = store.getAllMessages();
            expect(messages).toHaveLength(1);
            expect(messages[0].pubkey).toBe(USER_PUBKEY);
            expect(messages[0].message.role).toBe("user");
            expect(messages[0].message.content).toBe("Hello, help me with a task");
            expect(messages[0].eventId).toBe("event-1");
        });

        it("should hydrate agent response into store with RAL", () => {
            const conversationId = "conv-1";
            store.load(PROJECT_ID, conversationId);

            // First, add user message
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "Hello" },
                eventId: "user-event-1",
            });

            // Create RAL for agent
            const ralNumber = store.createRal(AGENT_PUBKEY);

            // Add agent response
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                message: { role: "assistant", content: "Hi there!" },
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
                message: { role: "user", content: "Hello" },
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
                    message: { role: "user", content: event.content },
                    eventId: event.id,
                });
            }

            // Second time: should skip (simulating our own event coming back)
            if (!store.hasEventId(event.id)) {
                store.addMessage({
                    pubkey: event.pubkey,
                    message: { role: "user", content: event.content },
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
                message: { role: "user", content: "Hello" },
                eventId: "event-1",
            });

            const ralNumber = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                message: { role: "assistant", content: "Hi there!" },
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

    describe("Message Building After Hydration", () => {
        it("should build correct messages for RAL execution", async () => {
            const conversationId = "conv-build";
            store.load(PROJECT_ID, conversationId);

            // Hydrate a multi-turn conversation
            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "Question 1" },
                eventId: "e1",
            });

            const ral1 = store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ral1,
                message: { role: "assistant", content: "Answer 1" },
                eventId: "e2",
            });
            store.completeRal(AGENT_PUBKEY, ral1);

            store.addMessage({
                pubkey: USER_PUBKEY,
                message: { role: "user", content: "Question 2" },
                eventId: "e3",
            });

            // Start new RAL
            const ral2 = store.createRal(AGENT_PUBKEY);

            // Build messages for new RAL
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            // Should include all messages from completed RAL + new user message
            expect(messages).toHaveLength(3);
            expect(messages[0].content).toBe("Question 1");
            expect(messages[1].content).toBe("Answer 1");
            expect(messages[2].content).toBe("Question 2");
        });
    });
});
