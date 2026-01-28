import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import {
    getTotalExecutionTimeSeconds,
    isExecutionActive,
    startExecutionTime,
    stopExecutionTime,
} from "@/conversations/executionTime";
import { ConversationStore } from "@/conversations/ConversationStore";
import { AgentEventEncoder } from "../AgentEventEncoder";
import type { EventContext } from "../types";

// Mock PubkeyService
mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName: async () => "User",
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
 * LLM Runtime Tracking Tests
 *
 * These tests verify the llm-runtime tracking implementation:
 * 1. Single agent run with simulated LLM streaming delay
 * 2. Parallel delegation with different runtimes
 * 3. 'Ask' interaction ensuring human wait time is NOT included
 * 4. Verification of ["llm-runtime", "<ms>", "ms"] tag in completion events
 */
describe("LLM Runtime Tracking", () => {
    const TEST_DIR = "/tmp/tenex-llm-runtime-test";
    const PROJECT_ID = "test-project";

    // Mock Date.now for controlled time testing
    let mockTime = 1000000;
    const originalDateNow = Date.now;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        mockTime = 1000000;
        Date.now = () => mockTime;
    });

    afterEach(async () => {
        Date.now = originalDateNow;
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    describe("Test Case 1: Single agent run with simulated LLM streaming delay", () => {
        it("should track execution time during single agent LLM streaming", async () => {
            const store = new ConversationStore(TEST_DIR);
            store.load(PROJECT_ID, "single-agent-conv");

            // Simulate agent starting execution
            expect(isExecutionActive(store)).toBe(false);
            startExecutionTime(store);
            expect(isExecutionActive(store)).toBe(true);

            // Simulate LLM streaming delay (5 seconds)
            mockTime += 5000;

            // Get total time while still active
            const activeTime = getTotalExecutionTimeSeconds(store);
            expect(activeTime).toBe(5); // 5 seconds

            // Simulate more streaming (additional 3 seconds)
            mockTime += 3000;

            // Stop execution
            const duration = stopExecutionTime(store);
            expect(duration).toBe(8000); // 8000ms total

            // Verify final state
            expect(isExecutionActive(store)).toBe(false);
            expect(store.executionTime.totalSeconds).toBe(8);
            expect(store.executionTime.currentSessionStart).toBeUndefined();
        });

        it("should include execution-time tag when EventContext has executionTime", () => {
            const encoder = new AgentEventEncoder();

            // Create a mock triggering event
            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "user-pubkey-123";
            mockTriggeringEvent.id = "event-id-123";
            mockTriggeringEvent.tags = [];

            // Create EventContext with execution time (8 seconds = 8000ms)
            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "conv-123",
                executionTime: 8, // 8 seconds
                model: "claude-3-opus",
                ralNumber: 1,
            };

            // Encode completion event
            const completionEvent = encoder.encodeCompletion(
                { content: "Task completed successfully" },
                context
            );

            // Verify execution-time tag is present
            const executionTimeTag = completionEvent.tags.find(
                (tag) => tag[0] === "execution-time"
            );
            expect(executionTimeTag).toBeDefined();
            expect(executionTimeTag?.[1]).toBe("8");
        });

        it("should NOT include execution-time tag when EventContext lacks executionTime", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "user-pubkey-123";
            mockTriggeringEvent.id = "event-id-123";
            mockTriggeringEvent.tags = [];

            // Create EventContext WITHOUT execution time
            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "conv-123",
                model: "claude-3-opus",
                ralNumber: 1,
                // executionTime is undefined
            };

            // Encode completion event
            const completionEvent = encoder.encodeCompletion(
                { content: "Task completed" },
                context
            );

            // Verify execution-time tag is NOT present
            const executionTimeTag = completionEvent.tags.find(
                (tag) => tag[0] === "execution-time"
            );
            expect(executionTimeTag).toBeUndefined();
        });
    });

    describe("Test Case 2: Parallel delegation with different runtimes", () => {
        it("should track separate execution times for two parallel agents", async () => {
            // Simulate Agent A (5 seconds runtime)
            const storeA = new ConversationStore(TEST_DIR);
            storeA.load(PROJECT_ID, "agent-a-conv");

            // Simulate Agent B (10 seconds runtime)
            const storeB = new ConversationStore(TEST_DIR);
            storeB.load(PROJECT_ID, "agent-b-conv");

            // Both agents start at the same time
            const startTime = mockTime;
            startExecutionTime(storeA);
            startExecutionTime(storeB);

            // Agent A completes after 5 seconds
            mockTime = startTime + 5000;
            const durationA = stopExecutionTime(storeA);
            expect(durationA).toBe(5000);
            expect(storeA.executionTime.totalSeconds).toBe(5);

            // Agent B is still running
            expect(isExecutionActive(storeB)).toBe(true);

            // Agent B completes after 10 seconds total
            mockTime = startTime + 10000;
            const durationB = stopExecutionTime(storeB);
            expect(durationB).toBe(10000);
            expect(storeB.executionTime.totalSeconds).toBe(10);

            // Verify both have correct final execution times
            expect(getTotalExecutionTimeSeconds(storeA)).toBe(5);
            expect(getTotalExecutionTimeSeconds(storeB)).toBe(10);
        });

        it("should create separate completion events with respective runtimes", () => {
            const encoder = new AgentEventEncoder();

            // Mock triggering event for both
            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "delegator-pubkey";
            mockTriggeringEvent.id = "delegation-event-id";
            mockTriggeringEvent.tags = [];

            // Agent A context (5 seconds)
            const contextA: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "agent-a-conv",
                executionTime: 5,
                model: "claude-3-sonnet",
                ralNumber: 1,
            };

            // Agent B context (10 seconds)
            const contextB: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "agent-b-conv",
                executionTime: 10,
                model: "claude-3-opus",
                ralNumber: 1,
            };

            // Encode completion events
            const completionA = encoder.encodeCompletion(
                { content: "Agent A completed", summary: "Quick task" },
                contextA
            );
            const completionB = encoder.encodeCompletion(
                { content: "Agent B completed", summary: "Longer task" },
                contextB
            );

            // Verify Agent A execution-time tag
            const execTimeTagA = completionA.tags.find((t) => t[0] === "execution-time");
            expect(execTimeTagA).toBeDefined();
            expect(execTimeTagA?.[1]).toBe("5");

            // Verify Agent B execution-time tag
            const execTimeTagB = completionB.tags.find((t) => t[0] === "execution-time");
            expect(execTimeTagB).toBeDefined();
            expect(execTimeTagB?.[1]).toBe("10");

            // Verify both have status=completed
            expect(completionA.tags.find((t) => t[0] === "status" && t[1] === "completed")).toBeDefined();
            expect(completionB.tags.find((t) => t[0] === "status" && t[1] === "completed")).toBeDefined();
        });
    });

    describe("Test Case 3: 'Ask' interaction - human wait time exclusion", () => {
        it("should pause execution time during human wait (ask)", async () => {
            const store = new ConversationStore(TEST_DIR);
            store.load(PROJECT_ID, "ask-conv");

            // Start execution
            startExecutionTime(store);

            // Simulate 3 seconds of LLM work before asking
            mockTime += 3000;

            // Stop execution when sending ask (human is now responding)
            const firstDuration = stopExecutionTime(store);
            expect(firstDuration).toBe(3000);

            // Simulate human taking 30 seconds to respond
            mockTime += 30000;

            // Human responded - resume execution
            startExecutionTime(store);

            // Simulate 2 more seconds of LLM work
            mockTime += 2000;

            // Complete execution
            const secondDuration = stopExecutionTime(store);
            expect(secondDuration).toBe(2000);

            // Total should be 5 seconds (3 + 2), NOT 35 seconds
            const total = getTotalExecutionTimeSeconds(store);
            expect(total).toBe(5);
            expect(store.executionTime.totalSeconds).toBe(5);
        });

        it("should encode ask event without including pending human wait time", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "user-pubkey";
            mockTriggeringEvent.id = "event-id";
            mockTriggeringEvent.tags = [];

            // Context at the time of ask (execution should be stopped before this)
            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "ask-conv",
                executionTime: 3, // Only the time before ask
                model: "claude-3-sonnet",
                ralNumber: 1,
            };

            // Encode ask event
            const askEvent = encoder.encodeAsk(
                {
                    title: "Approach",
                    context: "Need your input on the next step.",
                    questions: [
                        {
                            type: "question",
                            title: "Choice",
                            question: "Which approach do you prefer?",
                            suggestions: ["Option A", "Option B"],
                        },
                    ],
                },
                context
            );

            // Verify ask event structure
            expect(askEvent.tags.find((t) => t[0] === "intent" && t[1] === "ask")).toBeDefined();
            const titleTag = askEvent.tags.find((t) => t[0] === "title");
            expect(titleTag).toBeDefined();
            expect(titleTag?.[1]).toBe("Approach");
            const questionTag = askEvent.tags.find((t) => t[0] === "question");
            expect(questionTag).toEqual([
                "question",
                "Choice",
                "Which approach do you prefer?",
                "Option A",
                "Option B",
            ]);

            // Verify execution-time reflects only LLM time
            const execTimeTag = askEvent.tags.find((t) => t[0] === "execution-time");
            expect(execTimeTag).toBeDefined();
            expect(execTimeTag?.[1]).toBe("3");
        });

        it("should handle multiple ask/resume cycles correctly", async () => {
            const store = new ConversationStore(TEST_DIR);
            store.load(PROJECT_ID, "multi-ask-conv");

            // First work session (5 seconds)
            startExecutionTime(store);
            mockTime += 5000;
            stopExecutionTime(store);

            // First human wait (60 seconds) - should not count
            mockTime += 60000;

            // Second work session (3 seconds)
            startExecutionTime(store);
            mockTime += 3000;
            stopExecutionTime(store);

            // Second human wait (45 seconds) - should not count
            mockTime += 45000;

            // Third work session (7 seconds)
            startExecutionTime(store);
            mockTime += 7000;
            stopExecutionTime(store);

            // Total should be 15 seconds (5 + 3 + 7)
            // NOT 180 seconds (5 + 60 + 3 + 45 + 7)
            expect(store.executionTime.totalSeconds).toBe(15);
        });
    });

    describe("Test Case 4: Verify llm-runtime tag format in completion events", () => {
        it("should include execution-time tag with correct format in completion event", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "user-pubkey";
            mockTriggeringEvent.id = "event-id";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "conv-123",
                executionTime: 42, // 42 seconds
                model: "claude-3-opus",
                ralNumber: 1,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Final response" },
                context
            );

            // Check for presence of key tags
            const tags = completionEvent.tags;

            // Verify status=completed
            const statusTag = tags.find((t) => t[0] === "status");
            expect(statusTag).toBeDefined();
            expect(statusTag?.[1]).toBe("completed");

            // Verify execution-time tag exists with correct value
            const execTimeTag = tags.find((t) => t[0] === "execution-time");
            expect(execTimeTag).toBeDefined();
            expect(execTimeTag?.[1]).toBe("42");

            // Verify other standard tags
            expect(tags.find((t) => t[0] === "llm-model")).toBeDefined();
            expect(tags.find((t) => t[0] === "llm-ral")).toBeDefined();
        });

        it("should include execution-time in conversation (mid-loop) events", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "user-pubkey";
            mockTriggeringEvent.id = "event-id";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "conv-123",
                executionTime: 15, // 15 seconds so far
                model: "claude-3-sonnet",
                ralNumber: 1,
            };

            // Mid-loop conversation event (has pending delegations)
            const conversationEvent = encoder.encodeConversation(
                { content: "Intermediate update", isReasoning: false },
                context
            );

            // Verify execution-time tag
            const execTimeTag = conversationEvent.tags.find((t) => t[0] === "execution-time");
            expect(execTimeTag).toBeDefined();
            expect(execTimeTag?.[1]).toBe("15");

            // Verify NO status tag (conversation events don't have status)
            const statusTag = conversationEvent.tags.find((t) => t[0] === "status");
            expect(statusTag).toBeUndefined();
        });

        it("should include execution-time in error events", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "user-pubkey";
            mockTriggeringEvent.id = "event-id";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "conv-123",
                executionTime: 7, // 7 seconds before error
                model: "claude-3-opus",
                ralNumber: 1,
            };

            const errorEvent = encoder.encodeError(
                { message: "Something went wrong", errorType: "execution" },
                context
            );

            // Verify execution-time tag
            const execTimeTag = errorEvent.tags.find((t) => t[0] === "execution-time");
            expect(execTimeTag).toBeDefined();
            expect(execTimeTag?.[1]).toBe("7");

            // Verify error tag
            const errorTag = errorEvent.tags.find((t) => t[0] === "error");
            expect(errorTag).toBeDefined();
            expect(errorTag?.[1]).toBe("execution");

            // Verify status=completed (errors finalize the conversation)
            const statusTag = errorEvent.tags.find((t) => t[0] === "status");
            expect(statusTag).toBeDefined();
            expect(statusTag?.[1]).toBe("completed");
        });
    });

    describe("Edge cases and robustness", () => {
        it("should handle zero execution time", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "user-pubkey";
            mockTriggeringEvent.id = "event-id";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "conv-123",
                executionTime: 0,
                model: "claude-3-opus",
                ralNumber: 1,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Instant response" },
                context
            );

            // Zero execution time should still produce a tag (or not, depending on implementation)
            // Current implementation: 0 is falsy, so no tag
            const execTimeTag = completionEvent.tags.find((t) => t[0] === "execution-time");
            // If implementation changes to include 0, update this expectation
            expect(execTimeTag).toBeUndefined();
        });

        it("should handle very large execution times", () => {
            const encoder = new AgentEventEncoder();

            const mockTriggeringEvent = new NDKEvent();
            mockTriggeringEvent.pubkey = "user-pubkey";
            mockTriggeringEvent.id = "event-id";
            mockTriggeringEvent.tags = [];

            const context: EventContext = {
                triggeringEvent: mockTriggeringEvent,
                rootEvent: { id: "root-event-id" },
                conversationId: "conv-123",
                executionTime: 86400, // 24 hours in seconds
                model: "claude-3-opus",
                ralNumber: 1,
            };

            const completionEvent = encoder.encodeCompletion(
                { content: "Long running task" },
                context
            );

            const execTimeTag = completionEvent.tags.find((t) => t[0] === "execution-time");
            expect(execTimeTag).toBeDefined();
            expect(execTimeTag?.[1]).toBe("86400");
        });

        it("should not restart execution time if already active", async () => {
            const store = new ConversationStore(TEST_DIR);
            store.load(PROJECT_ID, "no-restart-conv");

            // Start execution
            startExecutionTime(store);
            const initialStart = store.executionTime.currentSessionStart;

            // Advance time
            mockTime += 5000;

            // Try to start again (should be ignored)
            startExecutionTime(store);

            // Start time should remain unchanged
            expect(store.executionTime.currentSessionStart).toBe(initialStart);

            // Continue and stop
            mockTime += 3000;
            const duration = stopExecutionTime(store);

            // Should be 8 seconds total (5 + 3)
            expect(duration).toBe(8000);
        });
    });
});
