import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    ensureExecutionTimeInitialized,
    getTotalExecutionTimeSeconds,
    initializeExecutionTime,
    isExecutionActive,
    startExecutionTime,
    stopExecutionTime,
} from "../executionTime";
import type { Conversation } from "../types";

// Mock Date.now for controlled time testing
let mockTime = 1000000;
const originalDateNow = Date.now;

// Helper to create test conversation
function createTestConversation(id: string): Conversation {
    const conversation: Conversation = {
        id,
        title: "Test Conversation",
        phase: "CHAT",
        history: [],
        metadata: {},
        executionTime: {
            totalSeconds: 0,
            currentSessionStart: undefined,
            isActive: false,
            lastUpdated: mockTime,
        },
    };
    return conversation;
}

describe("Execution Time Tracking", () => {
    beforeEach(() => {
        mockTime = 1000000;
        Date.now = () => mockTime;
    });

    afterEach(() => {
        Date.now = originalDateNow;
    });

    describe("Basic Operations", () => {
        it("should initialize execution time structure correctly", () => {
            const conversation = createTestConversation("test-conv-1");
            initializeExecutionTime(conversation);

            expect(conversation.executionTime).toBeDefined();
            expect(conversation.executionTime.totalSeconds).toBe(0);
            expect(conversation.executionTime.currentSessionStart).toBeUndefined();
            expect(conversation.executionTime.isActive).toBe(false);
            expect(conversation.executionTime.lastUpdated).toBe(mockTime);
        });

        it("should start execution time tracking", () => {
            const conversation = createTestConversation("test-conv-2");

            startExecutionTime(conversation);

            expect(conversation.executionTime.isActive).toBe(true);
            expect(conversation.executionTime.currentSessionStart).toBe(mockTime);
            expect(conversation.executionTime.lastUpdated).toBe(mockTime);
        });

        it("should not restart if already active", () => {
            const conversation = createTestConversation("test-conv-3");

            startExecutionTime(conversation);
            const firstStart = conversation.executionTime.currentSessionStart;

            mockTime += 1000;
            startExecutionTime(conversation); // Try to start again

            // Should not change the start time
            expect(conversation.executionTime.currentSessionStart).toBe(firstStart);
        });

        it("should stop execution time and calculate duration", () => {
            const conversation = createTestConversation("test-conv-4");

            startExecutionTime(conversation);
            mockTime += 5000; // 5 seconds later
            const duration = stopExecutionTime(conversation);

            expect(conversation.executionTime.isActive).toBe(false);
            expect(conversation.executionTime.currentSessionStart).toBeUndefined();
            expect(conversation.executionTime.totalSeconds).toBe(5);
            expect(duration).toBe(5000); // Duration in milliseconds
        });

        it("should calculate total time correctly including active session", () => {
            const conversation = createTestConversation("test-conv-5");
            conversation.executionTime.totalSeconds = 10; // Previous sessions

            startExecutionTime(conversation);
            mockTime += 5000; // 5 seconds of active session

            const totalSeconds = getTotalExecutionTimeSeconds(conversation);
            expect(totalSeconds).toBe(15); // 10 + 5
        });

        it("should return existing total when no active session", () => {
            const conversation = createTestConversation("test-conv-6");
            conversation.executionTime.totalSeconds = 25;

            const totalSeconds = getTotalExecutionTimeSeconds(conversation);
            expect(totalSeconds).toBe(25);
        });

        it("should correctly check if execution is active", () => {
            const conversation = createTestConversation("test-conv-7");

            expect(isExecutionActive(conversation)).toBe(false);

            startExecutionTime(conversation);
            expect(isExecutionActive(conversation)).toBe(true);

            stopExecutionTime(conversation);
            expect(isExecutionActive(conversation)).toBe(false);
        });

        it("should handle stop when not active", () => {
            const conversation = createTestConversation("test-conv-8");

            const duration = stopExecutionTime(conversation);
            expect(duration).toBe(0);
            expect(conversation.executionTime.totalSeconds).toBe(0);
        });
    });

    describe("Edge Cases", () => {
        it("should accumulate time across multiple start/stop cycles", () => {
            const conversation = createTestConversation("test-conv-9");

            // First session: 5 seconds
            startExecutionTime(conversation);
            mockTime += 5000;
            stopExecutionTime(conversation);

            // Second session: 3 seconds
            mockTime += 10000; // User thinking time (not counted)
            startExecutionTime(conversation);
            mockTime += 3000;
            stopExecutionTime(conversation);

            // Third session: 7 seconds
            mockTime += 5000; // User thinking time (not counted)
            startExecutionTime(conversation);
            mockTime += 7000;
            stopExecutionTime(conversation);

            expect(conversation.executionTime.totalSeconds).toBe(15); // 5 + 3 + 7
        });

        it("should handle very large time values without overflow", () => {
            const conversation = createTestConversation("test-conv-10");

            startExecutionTime(conversation);
            mockTime += 365 * 24 * 60 * 60 * 1000; // 1 year in milliseconds
            stopExecutionTime(conversation);

            expect(conversation.executionTime.totalSeconds).toBe(365 * 24 * 60 * 60);
            expect(conversation.executionTime.totalSeconds).toBeGreaterThan(0); // No overflow
        });

        it("should round seconds correctly", () => {
            const conversation = createTestConversation("test-conv-11");

            startExecutionTime(conversation);
            mockTime += 1499; // Just under 1.5 seconds
            stopExecutionTime(conversation);
            expect(conversation.executionTime.totalSeconds).toBe(1); // Rounds down

            startExecutionTime(conversation);
            mockTime += 1500; // Exactly 1.5 seconds
            stopExecutionTime(conversation);
            expect(conversation.executionTime.totalSeconds).toBe(3); // 1 + 2 (rounds up)
        });
    });

    describe("Crash Recovery", () => {
        it("should ensure execution time is initialized for loaded conversations", () => {
            const conversation: Conversation = {
                id: "loaded-conv-1",
                title: "Loaded",
                phase: "CHAT",
                history: [],
                metadata: {},
                executionTime: undefined as any, // Simulate missing executionTime
            };

            ensureExecutionTimeInitialized(conversation);

            expect(conversation.executionTime).toBeDefined();
            expect(conversation.executionTime.totalSeconds).toBe(0);
            expect(conversation.executionTime.isActive).toBe(false);
        });

        it("should detect and reset stale active sessions", () => {
            const conversation = createTestConversation("stale-conv-1");
            conversation.executionTime.isActive = true;
            conversation.executionTime.currentSessionStart = mockTime - 45 * 60 * 1000; // 45 minutes ago
            conversation.executionTime.lastUpdated = mockTime - 45 * 60 * 1000;

            ensureExecutionTimeInitialized(conversation);

            expect(conversation.executionTime.isActive).toBe(false);
            expect(conversation.executionTime.currentSessionStart).toBeUndefined();
            expect(conversation.executionTime.lastUpdated).toBe(mockTime);
        });

        it("should not reset recent active sessions", () => {
            const conversation = createTestConversation("recent-conv-1");
            conversation.executionTime.isActive = true;
            conversation.executionTime.currentSessionStart = mockTime - 10 * 60 * 1000; // 10 minutes ago
            conversation.executionTime.lastUpdated = mockTime - 10 * 60 * 1000;

            ensureExecutionTimeInitialized(conversation);

            expect(conversation.executionTime.isActive).toBe(true); // Still active
            expect(conversation.executionTime.currentSessionStart).toBe(mockTime - 10 * 60 * 1000);
        });

        it("should handle conversations with partial execution time data", () => {
            const conversation: Conversation = {
                id: "partial-conv-1",
                title: "Partial",
                phase: "CHAT",
                history: [],
                metadata: {},
                executionTime: {
                    totalSeconds: 100,
                    isActive: false,
                } as any, // Missing fields
            };

            ensureExecutionTimeInitialized(conversation);

            expect(conversation.executionTime.totalSeconds).toBe(100); // Preserved
            expect(conversation.executionTime.currentSessionStart).toBeUndefined();
            // lastUpdated is only set if we need to reset stale sessions
            expect(conversation.executionTime.isActive).toBe(false);
        });
    });

    describe("Integration with Nostr Events", () => {
        it("should provide accurate NET_TIME tag value", () => {
            const conversation = createTestConversation("net-time-1");
            conversation.executionTime.totalSeconds = 42;

            // Active session adds 8 more seconds
            startExecutionTime(conversation);
            mockTime += 8000;

            const netTime = getTotalExecutionTimeSeconds(conversation);
            expect(netTime).toBe(50); // 42 + 8
        });

        it("should handle rapid start/stop cycles", () => {
            const conversation = createTestConversation("rapid-1");

            // Simulate rapid tool executions with longer durations
            for (let i = 0; i < 5; i++) {
                startExecutionTime(conversation);
                mockTime += 1000; // 1 second per tool
                stopExecutionTime(conversation);
                mockTime += 50; // 50ms between tools (not counted)
            }

            expect(conversation.executionTime.totalSeconds).toBe(5); // 5 * 1s = 5s
        });
    });
});
