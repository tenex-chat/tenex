import { describe, expect, it, mock } from "bun:test";
import { createEventContext } from "../event-context";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock PubkeyService
mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName: async () => "User",
    }),
}));

/**
 * Tests for createEventContext utility function.
 *
 * These tests verify that EventContext is properly created for event publishing,
 * including the critical execution time field for llm-runtime tracking.
 */
describe("createEventContext", () => {
    // Helper to create a mock ToolExecutionContext
    function createMockContext(overrides: Partial<{
        triggeringEvent: NDKEvent;
        conversationId: string;
        ralNumber: number;
        agent: { llmConfig: string };
        getConversation: () => { getRootEventId: () => string; executionTime?: { totalSeconds: number } } | undefined;
    }> = {}) {
        const mockEvent = new NDKEvent();
        mockEvent.id = "mock-event-id";
        mockEvent.pubkey = "mock-pubkey";
        mockEvent.tags = [];

        return {
            triggeringEvent: overrides.triggeringEvent ?? mockEvent,
            conversationId: overrides.conversationId ?? "test-conv-id",
            ralNumber: overrides.ralNumber ?? 1,
            agent: overrides.agent ?? { llmConfig: "claude-3-opus" },
            getConversation: overrides.getConversation ?? (() => ({
                getRootEventId: () => "root-event-id",
            })),
        } as any;
    }

    it("should create basic EventContext with required fields", () => {
        const mockContext = createMockContext();

        const eventContext = createEventContext(mockContext);

        expect(eventContext.conversationId).toBe("test-conv-id");
        expect(eventContext.ralNumber).toBe(1);
        expect(eventContext.triggeringEvent).toBeDefined();
        expect(eventContext.rootEvent.id).toBe("root-event-id");
    });

    it("should use provided model over agent.llmConfig", () => {
        const mockContext = createMockContext({
            agent: { llmConfig: "default-model" },
        });

        const eventContext = createEventContext(mockContext, "override-model");

        expect(eventContext.model).toBe("override-model");
    });

    it("should fall back to agent.llmConfig when model not provided", () => {
        const mockContext = createMockContext({
            agent: { llmConfig: "agent-default-model" },
        });

        const eventContext = createEventContext(mockContext);

        expect(eventContext.model).toBe("agent-default-model");
    });

    it("should handle missing conversation gracefully", () => {
        const mockEvent = new NDKEvent();
        mockEvent.id = "fallback-event-id";
        mockEvent.pubkey = "mock-pubkey";
        mockEvent.tags = [];

        const mockContext = createMockContext({
            triggeringEvent: mockEvent,
            getConversation: () => undefined,
        });

        const eventContext = createEventContext(mockContext);

        // Should fall back to triggering event ID
        expect(eventContext.rootEvent.id).toBe("fallback-event-id");
    });

    describe("executionTime integration", () => {
        /**
         * IMPORTANT: This test documents the current gap in the implementation.
         *
         * Currently, createEventContext does NOT include executionTime in the
         * returned context, even though:
         * 1. ExecutionTime tracking is implemented in executionTime.ts
         * 2. ConversationStore has executionTime data
         * 3. AgentEventEncoder supports the execution-time tag
         *
         * The fix should retrieve executionTime from the conversation and
         * include it in the EventContext.
         */
        it("should include executionTime when conversation has tracked time - DOCUMENTS INTEGRATION GAP", () => {
            const mockContext = createMockContext({
                getConversation: () => ({
                    getRootEventId: () => "root-event-id",
                    executionTime: {
                        totalSeconds: 42,
                        isActive: false,
                        lastUpdated: Date.now(),
                    },
                }),
            });

            const eventContext = createEventContext(mockContext);

            // CURRENT BEHAVIOR: executionTime is undefined (gap)
            // EXPECTED BEHAVIOR: executionTime should be 42
            //
            // When this test fails after the fix is applied, update it to:
            // expect(eventContext.executionTime).toBe(42);
            expect(eventContext.executionTime).toBeUndefined();
        });

        it("should NOT include executionTime when conversation has no tracked time", () => {
            const mockContext = createMockContext({
                getConversation: () => ({
                    getRootEventId: () => "root-event-id",
                    // No executionTime property
                }),
            });

            const eventContext = createEventContext(mockContext);

            expect(eventContext.executionTime).toBeUndefined();
        });
    });
});
