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

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import type { ToolCallPart, ToolResultPart } from "ai";
import {
    ConversationStore,
    type ConversationEntry,
    type Injection,
} from "../ConversationStore";

// Mock PubkeyService for attribution tests
const mockGetName = mock(async (pubkey: string) => {
    const names: Record<string, string> = {
        "transparent-pk": "transparent",
        "agent1-pk": "agent1",
        "agent2-pk": "agent2",
        "pablo-pk": "Pablo",
    };
    return names[pubkey] ?? "Unknown";
});

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName: mockGetName,
    }),
}));

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
                content: "hello",
                messageType: "text",
            };
            store.addMessage(entry);
            await store.save();

            const filePath = join(
                TEST_DIR,
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
                content: "hello",
                messageType: "text",
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

        it("should include all user messages for any agent", async () => {
            // User message
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "hello",
                messageType: "text",
            });

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
        });

        it("should include all messages from same agent completed RALs", async () => {
            // RAL 1 - completed
            store.createRal(AGENT1_PUBKEY);
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "I will help",
                messageType: "text",
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "read_path",
                    input: { path: "/tmp/test" },
                }] as ToolCallPart[],
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-result",
                toolData: [{
                    type: "tool-result",
                    toolCallId: "call_1",
                    toolName: "read_path",
                    output: { type: "text", value: "file content" },
                }] as ToolResultPart[],
            });
            store.completeRal(AGENT1_PUBKEY, 1);

            // RAL 2 - current
            const ral2 = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral2);

            // Should include all messages from completed RAL 1
            expect(messages).toHaveLength(3);
        });

        it("should exclude messages from other active RALs", async () => {
            // RAL 1 - active (not completed)
            store.createRal(AGENT1_PUBKEY);
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "Working on it",
                messageType: "text",
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "read_path",
                    input: { path: "/tmp/test" },
                }] as ToolCallPart[],
            });

            // RAL 2 - current
            const ral2 = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral2);

            // Should NOT include RAL 1 messages - other active RALs are excluded
            expect(messages).toHaveLength(0);
        });

        it("should include only text outputs from other agents", async () => {
            // Agent 2 messages
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "I am agent 2",
                messageType: "text",
            });
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "read_path",
                    input: {},
                }] as ToolCallPart[],
            });
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-result",
                toolData: [{
                    type: "tool-result",
                    toolCallId: "call_1",
                    toolName: "read_path",
                    output: { type: "text", value: "content" },
                }] as ToolResultPart[],
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            // Agent 1 RAL
            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            // Should only include the text output, not tool calls/results
            // Broadcasts from other agents - role will change with new implementation
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user"); // Changed: all non-self = user
            expect(messages[0].content).toContain("I am agent 2");
        });

        it("should exclude messages with only tool calls from other agents", async () => {
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "read_path",
                    input: {},
                }] as ToolCallPart[],
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(0);
        });

        it("should use 'user' role for targeted agent-to-agent messages", async () => {
            // Agent2 sends a targeted message to Agent1 via p-tag
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "What is your role in this project?",
                messageType: "text",
                targetedPubkeys: [AGENT1_PUBKEY],
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            // Agent1 builds messages for its RAL
            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            // Targeted messages from other agents appear as "user" to the target
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
        });

        it("should use 'user' role for broadcast agent messages", async () => {
            // Agent2 broadcasts (no specific target)
            // All non-self messages use "user" role
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "I have completed my analysis.",
                messageType: "text",
                // No targetedPubkeys = broadcast
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            // Agent1 builds messages for its RAL
            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user"); // Changed: all non-self = user
        });

        it("should use 'user' role for observers of targeted messages", async () => {
            // Agent2 sends a message targeted to Agent1
            // A third agent (Agent3) observing should see as "user" (all non-self)
            const AGENT3_PUBKEY = "agent3-pubkey-ghi";

            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "Here is my analysis.",
                messageType: "text",
                targetedPubkeys: [AGENT1_PUBKEY],
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            // Agent3 builds messages - all non-self messages are "user"
            const ral = store.createRal(AGENT3_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT3_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user"); // Changed: all non-self = user
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
            expect(messages[0].content).toBe("injected message");

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
                content: "hello",
                messageType: "text",
                eventId: "event-123",
            });

            expect(store.hasEventId("event-123")).toBe(true);
            expect(store.hasEventId("event-456")).toBe(false);
        });

        it("should allow setting event ID after message creation", () => {
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "response",
                messageType: "text",
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

    describe("Message Attribution Formatting", () => {
        // Use pubkeys that map to our mock names
        const TRANSPARENT_PK = "transparent-pk";
        const AGENT1_PK = "agent1-pk";
        const AGENT2_PK = "agent2-pk";
        const PABLO_PK = "pablo-pk";

        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            // Register agents so ConversationStore knows they're agents
            ConversationStore.initialize("/test/project", [TRANSPARENT_PK, AGENT1_PK, AGENT2_PK]);
            mockGetName.mockClear();
        });

        it("should prefix own message with [@self -> @recipient]", async () => {
            // Transparent sends a message to Pablo
            store.addMessage({
                pubkey: TRANSPARENT_PK,
                ral: 1,
                content: "Hello Pablo!",
                messageType: "text",
                targetedPubkeys: [PABLO_PK],
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("assistant");
            expect(messages[0].content).toBe("[@transparent -> @Pablo] Hello Pablo!");
        });

        it("should prefix own broadcast with [@self]", async () => {
            // Transparent broadcasts (no recipient)
            store.addMessage({
                pubkey: TRANSPARENT_PK,
                ral: 1,
                content: "Announcement to all",
                messageType: "text",
                // No targetedPubkeys = broadcast
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("assistant");
            expect(messages[0].content).toBe("[@transparent] Announcement to all");
        });

        it("should prefix message TO agent from user with [@sender -> @self]", async () => {
            // Pablo sends message to Transparent
            store.addMessage({
                pubkey: PABLO_PK,
                content: "Hello Transparent!",
                messageType: "text",
                targetedPubkeys: [TRANSPARENT_PK],
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            expect(messages[0].content).toBe("[@Pablo -> @transparent] Hello Transparent!");
        });

        it("should prefix message TO agent from another agent with [@sender -> @self]", async () => {
            // Agent1 sends message to Transparent
            store.addMessage({
                pubkey: AGENT1_PK,
                ral: 1,
                content: "Hey Transparent, can you help?",
                messageType: "text",
                targetedPubkeys: [TRANSPARENT_PK],
            });
            store.completeRal(AGENT1_PK, 1);
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            expect(messages[0].content).toBe("[@agent1 -> @transparent] Hey Transparent, can you help?");
        });

        it("should prefix observed user-to-agent message with [@sender -> @recipient]", async () => {
            // Pablo sends message to Agent1, Transparent is observing
            store.addMessage({
                pubkey: PABLO_PK,
                content: "Agent1, what color?",
                messageType: "text",
                targetedPubkeys: [AGENT1_PK],
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user"); // All non-self messages are "user"
            expect(messages[0].content).toBe("[@Pablo -> @agent1] Agent1, what color?");
        });

        it("should prefix observed agent-to-agent message with [@sender -> @recipient]", async () => {
            // Agent1 sends to Agent2, Transparent is observing
            store.addMessage({
                pubkey: AGENT1_PK,
                ral: 1,
                content: "Agent2, I need your analysis",
                messageType: "text",
                targetedPubkeys: [AGENT2_PK],
            });
            store.completeRal(AGENT1_PK, 1);
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user"); // All non-self messages are "user"
            expect(messages[0].content).toBe("[@agent1 -> @agent2] Agent2, I need your analysis");
        });

        it("should prefix user broadcast with [@sender]", async () => {
            // Pablo broadcasts to all agents
            store.addMessage({
                pubkey: PABLO_PK,
                content: "Everyone, listen up!",
                messageType: "text",
                // No targetedPubkeys = broadcast
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            expect(messages[0].content).toBe("[@Pablo] Everyone, listen up!");
        });

        it("should format multiple recipients correctly", async () => {
            // Pablo sends to both Agent1 and Agent2
            store.addMessage({
                pubkey: PABLO_PK,
                content: "Both of you, collaborate!",
                messageType: "text",
                targetedPubkeys: [AGENT1_PK, AGENT2_PK],
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user"); // Observing
            expect(messages[0].content).toBe("[@Pablo -> @agent1, @agent2] Both of you, collaborate!");
        });

        it("should exclude other active RAL messages from buildMessagesForRal", async () => {
            // Create active RAL with messages
            store.ensureRalActive(TRANSPARENT_PK, 1);
            store.addMessage({
                pubkey: TRANSPARENT_PK,
                ral: 1,
                content: "Working on task 1",
                messageType: "text",
            });

            // Create second RAL - should NOT see RAL 1 messages
            // (concurrent RAL context is added separately by AgentExecutor)
            store.ensureRalActive(TRANSPARENT_PK, 2);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 2);

            // No messages from other active RALs should be included
            expect(messages).toHaveLength(0);
        });
    });
});
