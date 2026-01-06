import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, rm } from "fs/promises";
import {
    getTotalExecutionTimeSeconds,
    isExecutionActive,
    startExecutionTime,
    stopExecutionTime,
} from "../executionTime";
import { ConversationStore } from "../ConversationStore";

// Mock PubkeyService
mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName: async () => "User",
    }),
}));

describe("executionTime", () => {
    const TEST_DIR = "/tmp/tenex-execution-time-test";
    const PROJECT_ID = "test-project";
    let store: ConversationStore;

    // Mock Date.now for controlled time testing
    let mockTime = 1000000;
    const originalDateNow = Date.now;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, "test-conv");
        mockTime = 1000000;
        Date.now = () => mockTime;
    });

    afterEach(async () => {
        Date.now = originalDateNow;
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    describe("startExecutionTime", () => {
        it("should start tracking execution time", () => {
            expect(isExecutionActive(store)).toBe(false);

            startExecutionTime(store);

            expect(isExecutionActive(store)).toBe(true);
            expect(store.executionTime.currentSessionStart).toBe(mockTime);
        });

        it("should not restart if already active", () => {
            startExecutionTime(store);
            const firstStart = store.executionTime.currentSessionStart;

            mockTime += 5000;
            startExecutionTime(store);

            // Should still have the original start time
            expect(store.executionTime.currentSessionStart).toBe(firstStart);
        });
    });

    describe("stopExecutionTime", () => {
        it("should stop tracking and add to total", () => {
            startExecutionTime(store);

            mockTime += 30000; // 30 seconds
            const duration = stopExecutionTime(store);

            expect(duration).toBe(30000);
            expect(isExecutionActive(store)).toBe(false);
            expect(store.executionTime.totalSeconds).toBe(30);
            expect(store.executionTime.currentSessionStart).toBeUndefined();
        });

        it("should return 0 if not active", () => {
            const duration = stopExecutionTime(store);
            expect(duration).toBe(0);
        });

        it("should accumulate across multiple sessions", () => {
            // First session: 30 seconds
            startExecutionTime(store);
            mockTime += 30000;
            stopExecutionTime(store);

            // Second session: 45 seconds
            startExecutionTime(store);
            mockTime += 45000;
            stopExecutionTime(store);

            expect(store.executionTime.totalSeconds).toBe(75);
        });
    });

    describe("getTotalExecutionTimeSeconds", () => {
        it("should return total including active session", () => {
            // Previous completed: 60 seconds
            store.executionTime.totalSeconds = 60;

            // Start new session
            startExecutionTime(store);
            mockTime += 15000; // 15 seconds active

            const total = getTotalExecutionTimeSeconds(store);
            expect(total).toBe(75); // 60 + 15
        });

        it("should return just total when not active", () => {
            store.executionTime.totalSeconds = 120;

            const total = getTotalExecutionTimeSeconds(store);
            expect(total).toBe(120);
        });
    });

    describe("isExecutionActive", () => {
        it("should return true when active", () => {
            startExecutionTime(store);
            expect(isExecutionActive(store)).toBe(true);
        });

        it("should return false when not active", () => {
            expect(isExecutionActive(store)).toBe(false);
        });

        it("should return false after stopping", () => {
            startExecutionTime(store);
            stopExecutionTime(store);
            expect(isExecutionActive(store)).toBe(false);
        });
    });
});
