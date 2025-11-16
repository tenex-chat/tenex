import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Conversation } from "../../types";
import { ConversationEventProcessor } from "../ConversationEventProcessor";

// Mock the getAgentSlugFromEvent function
mock.module("@/nostr/utils", () => ({
    getAgentSlugFromEvent: (event: NDKEvent) => {
        // Map specific pubkeys to agent slugs for testing
        if (event.pubkey === "executor-pubkey") return "executor";
        if (event.pubkey === "planner-pubkey") return "planner";
        return undefined;
    },
    isEventFromUser: (event: NDKEvent) => event.pubkey === "user-pubkey",
}));

describe("ConversationEventProcessor", () => {
    let processor: ConversationEventProcessor;

    beforeEach(() => {
        processor = new ConversationEventProcessor();
    });

    describe("extractCompletionFromEvent", () => {
        it("should extract completion from event with status completed tag and valid pubkey", () => {
            const event = {
                content: "Task completed successfully",
                pubkey: "executor-pubkey",
                tags: [["status", "completed"]],
                created_at: 1234567890,
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toEqual({
                agent: "executor",
                message: "Task completed successfully",
                timestamp: 1234567890,
            });
        });

        it("should return null if no status completed tag", () => {
            const event = {
                content: "Regular message",
                pubkey: "executor-pubkey",
                tags: [],
                created_at: 1234567890,
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toBeNull();
        });

        it("should return null if pubkey doesn't map to an agent", () => {
            const event = {
                content: "Task completed",
                pubkey: "unknown-pubkey",
                tags: [["status", "completed"]],
                created_at: 1234567890,
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toBeNull();
        });

        it("should return null if no content", () => {
            const event = {
                content: "",
                pubkey: "executor-pubkey",
                tags: [["status", "completed"]],
                created_at: 1234567890,
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toBeNull();
        });

        it("should return null if status tag is not 'completed'", () => {
            const event = {
                content: "Using a tool",
                pubkey: "executor-pubkey",
                tags: [["status", "in-progress"]],
                created_at: 1234567890,
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toBeNull();
        });

        it("should work with different agent pubkeys", () => {
            const event = {
                content: "Planning complete",
                pubkey: "planner-pubkey",
                tags: [["status", "completed"]],
                created_at: 1234567890,
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toEqual({
                agent: "planner",
                message: "Planning complete",
                timestamp: 1234567890,
            });
        });
    });

    describe("processIncomingEvent - duplicate prevention", () => {
        it("should add new event to conversation history", () => {
            const conversation: Conversation = {
                id: "conv-1",
                title: "Test Conversation",
                phase: "CHAT",
                history: [],
                agentStates: new Map(),
                phaseStartedAt: Date.now(),
                metadata: {},
                executionTime: {
                    totalSeconds: 0,
                    isActive: false,
                    lastUpdated: Date.now(),
                },
            };

            const event = {
                id: "event-1",
                content: "Test message",
                pubkey: "user-pubkey",
                created_at: 1234567890,
            } as NDKEvent;

            processor.processIncomingEvent(conversation, event);

            expect(conversation.history).toHaveLength(1);
            expect(conversation.history[0].id).toBe("event-1");
        });

        it("should not add duplicate event with same id", () => {
            const existingEvent = {
                id: "event-1",
                content: "First message",
                pubkey: "user-pubkey",
                created_at: 1234567890,
            } as NDKEvent;

            const conversation: Conversation = {
                id: "conv-1",
                title: "Test Conversation",
                phase: "CHAT",
                history: [existingEvent],
                agentStates: new Map(),
                phaseStartedAt: Date.now(),
                metadata: {},
                executionTime: {
                    totalSeconds: 0,
                    isActive: false,
                    lastUpdated: Date.now(),
                },
            };

            const duplicateEvent = {
                id: "event-1",
                content: "Duplicate message with same ID",
                pubkey: "another-pubkey",
                created_at: 9999999999,
            } as NDKEvent;

            processor.processIncomingEvent(conversation, duplicateEvent);

            // History should still have only one event
            expect(conversation.history).toHaveLength(1);
            // Original event should be preserved
            expect(conversation.history[0].content).toBe("First message");
            expect(conversation.history[0].pubkey).toBe("user-pubkey");
        });

        it("should add multiple unique events", () => {
            const conversation: Conversation = {
                id: "conv-1",
                title: "Test Conversation",
                phase: "CHAT",
                history: [],
                agentStates: new Map(),
                phaseStartedAt: Date.now(),
                metadata: {},
                executionTime: {
                    totalSeconds: 0,
                    isActive: false,
                    lastUpdated: Date.now(),
                },
            };

            const event1 = {
                id: "event-1",
                content: "First message",
                pubkey: "user-pubkey",
                created_at: 1234567890,
            } as NDKEvent;

            const event2 = {
                id: "event-2",
                content: "Second message",
                pubkey: "executor-pubkey",
                created_at: 1234567891,
            } as NDKEvent;

            const event3 = {
                id: "event-3",
                content: "Third message",
                pubkey: "planner-pubkey",
                created_at: 1234567892,
            } as NDKEvent;

            processor.processIncomingEvent(conversation, event1);
            processor.processIncomingEvent(conversation, event2);
            processor.processIncomingEvent(conversation, event3);

            expect(conversation.history).toHaveLength(3);
            expect(conversation.history[0].id).toBe("event-1");
            expect(conversation.history[1].id).toBe("event-2");
            expect(conversation.history[2].id).toBe("event-3");
        });

        it("should handle mixed unique and duplicate events", () => {
            const conversation: Conversation = {
                id: "conv-1",
                title: "Test Conversation",
                phase: "CHAT",
                history: [],
                agentStates: new Map(),
                phaseStartedAt: Date.now(),
                metadata: {},
                executionTime: {
                    totalSeconds: 0,
                    isActive: false,
                    lastUpdated: Date.now(),
                },
            };

            const event1 = {
                id: "event-1",
                content: "First message",
                pubkey: "user-pubkey",
                created_at: 1234567890,
            } as NDKEvent;

            const event2 = {
                id: "event-2",
                content: "Second message",
                pubkey: "executor-pubkey",
                created_at: 1234567891,
            } as NDKEvent;

            // Process events including duplicates
            processor.processIncomingEvent(conversation, event1);
            processor.processIncomingEvent(conversation, event2);
            processor.processIncomingEvent(conversation, event1); // duplicate
            processor.processIncomingEvent(conversation, event2); // duplicate

            const event3 = {
                id: "event-3",
                content: "Third message",
                pubkey: "planner-pubkey",
                created_at: 1234567892,
            } as NDKEvent;

            processor.processIncomingEvent(conversation, event3);
            processor.processIncomingEvent(conversation, event1); // duplicate again

            // Should only have 3 unique events
            expect(conversation.history).toHaveLength(3);
            expect(conversation.history[0].id).toBe("event-1");
            expect(conversation.history[1].id).toBe("event-2");
            expect(conversation.history[2].id).toBe("event-3");
        });
    });
});
