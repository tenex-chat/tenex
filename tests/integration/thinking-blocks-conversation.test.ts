/**
 * Integration test for thinking block filtering in conversation history
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentConversationContext } from "@/conversations/AgentConversationContext";
import type { Conversation, AgentState } from "@/conversations/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { vi } from "vitest";

// Mock the external dependencies
vi.mock("@/nostr/utils", () => ({
    getAgentSlugFromEvent: vi.fn(() => "test-agent"),
    isEventFromUser: vi.fn(() => true),
    getTargetedAgentSlugsFromEvent: vi.fn(() => [])
}));

vi.mock("@/services", () => ({
    getProjectContext: vi.fn(() => ({
        agents: new Map(),
        getAgentByPubkey: vi.fn()
    }))
}));

vi.mock("@/services/PubkeyNameRepository", () => ({
    getPubkeyNameRepository: vi.fn(() => ({
        getName: vi.fn(() => Promise.resolve("TestUser"))
    }))
}));

vi.mock("@/conversations/processors/NostrEntityProcessor", () => ({
    NostrEntityProcessor: {
        processEntities: vi.fn((content: string) => Promise.resolve(content))
    }
}));

describe("Thinking Blocks in Conversation History", () => {
    let context: AgentConversationContext;
    let mockConversation: Conversation;
    let mockAgentState: AgentState;

    beforeEach(() => {
        context = new AgentConversationContext("test-conversation", "test-agent");
        
        mockAgentState = {
            lastProcessedMessageIndex: 0,
            lastSeenPhase: undefined
        };

        mockConversation = {
            id: "test-conversation",
            phase: "draft",
            history: [],
            metadata: new Map(),
            agentStates: new Map([["test-agent", mockAgentState]]),
            createdAt: Date.now(),
            executionTime: { isExecuting: false }
        };
    });

    it("should exclude messages that are only thinking blocks from history", async () => {
        // Create mock events with various content types
        const events: NDKEvent[] = [
            {
                id: "event1",
                content: "Hello, I need help with a task.",
                tags: [],
                created_at: 1000,
                pubkey: "user-pubkey",
                kind: 1,
                sig: "sig1"
            } as NDKEvent,
            {
                id: "event2",
                content: "<thinking>Let me analyze this request...</thinking>",
                tags: [],
                created_at: 1001,
                pubkey: "agent-pubkey",
                kind: 1,
                sig: "sig2"
            } as NDKEvent,
            {
                id: "event3",
                content: "I can help you with that. <thinking>internal reasoning</thinking> Here's what we'll do:",
                tags: [],
                created_at: 1002,
                pubkey: "agent-pubkey",
                kind: 1,
                sig: "sig3"
            } as NDKEvent
        ];

        mockConversation.history = events;

        const messages = await context.buildMessages(
            mockConversation,
            mockAgentState,
            undefined,
            undefined
        );

        // Should have 2 messages (event1 and event3, but not event2)
        expect(messages.length).toBe(2);
        
        // First message should be the user's request
        expect(messages[0].content).toBe("Hello, I need help with a task.");
        expect(messages[0].role).toBe("user");
        
        // Second message should have thinking blocks stripped
        expect(messages[1].content).toBe("I can help you with that. Here's what we'll do:");
        expect(messages[1].role).toBe("user");
    });

    it("should handle triggering events with thinking blocks", async () => {
        const triggeringEvent: NDKEvent = {
            id: "trigger-event",
            content: "<thinking>User wants X, I should do Y</thinking>Let me process your request.",
            tags: [],
            created_at: 2000,
            pubkey: "user-pubkey",
            kind: 1,
            sig: "sig-trigger"
        } as NDKEvent;

        const messages = await context.buildMessages(
            mockConversation,
            mockAgentState,
            triggeringEvent,
            undefined
        );

        // Should have the triggering event with thinking blocks stripped
        expect(messages.length).toBe(1);
        expect(messages[0].content).toBe("Let me process your request.");
    });

    it("should skip triggering event if it contains only thinking blocks", async () => {
        const triggeringEvent: NDKEvent = {
            id: "trigger-event",
            content: "<thinking>This is only internal reasoning with no user-facing content</thinking>",
            tags: [],
            created_at: 2000,
            pubkey: "agent-pubkey",
            kind: 1,
            sig: "sig-trigger"
        } as NDKEvent;

        const messages = await context.buildMessages(
            mockConversation,
            mockAgentState,
            triggeringEvent,
            undefined
        );

        // Should have no messages since the triggering event is only thinking
        expect(messages.length).toBe(0);
    });

    it("should handle mixed-case thinking tags correctly", async () => {
        const events: NDKEvent[] = [
            {
                id: "event1",
                content: "Start <THINKING>uppercase thinking</THINKING> middle <Thinking>mixed case</Thinking> end",
                tags: [],
                created_at: 1000,
                pubkey: "user-pubkey",
                kind: 1,
                sig: "sig1"
            } as NDKEvent
        ];

        mockConversation.history = events;

        const messages = await context.buildMessages(
            mockConversation,
            mockAgentState,
            undefined,
            undefined
        );

        expect(messages.length).toBe(1);
        expect(messages[0].content).toBe("Start middle end");
    });
});