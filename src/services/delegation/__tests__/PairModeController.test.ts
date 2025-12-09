import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { PairModeController, PairModeAbortError } from "../PairModeController";
import { PairModeRegistry } from "../PairModeRegistry";
import type { PairModeConfig } from "../types";

describe("PairModeController", () => {
    const agentPubkey = "agent-pubkey-abc";
    const agentSlug = "test-agent";
    const config: Required<PairModeConfig> = {
        stepThreshold: 5,
        checkInTimeoutMs: 1000,
    };

    let batchId: string;
    let controller: PairModeController;
    let registry: PairModeRegistry;

    beforeEach(() => {
        // Reset singleton to ensure clean state
        PairModeRegistry.resetInstance();
        // Use unique batchId for each test to avoid state pollution
        batchId = `controller-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        // Get fresh registry instance and clear state
        registry = PairModeRegistry.getInstance();
        // Register the delegation so the controller can find it
        registry.registerPairDelegation(batchId, "delegator-pubkey", config);

        controller = new PairModeController(batchId, agentPubkey, agentSlug, config);
    });

    afterEach(() => {
        // Clean up the delegation after each test
        registry.cleanup(batchId);
    });

    describe("getBatchId", () => {
        it("should return the batch ID", () => {
            expect(controller.getBatchId()).toBe(batchId);
        });
    });

    describe("createStopCheck", () => {
        it("should return false when below step threshold", async () => {
            const stopCheck = controller.createStopCheck();

            // Simulate 3 steps (below threshold of 5)
            const steps = Array(3).fill({ toolCalls: [] });
            const shouldStop = await stopCheck(steps);

            expect(shouldStop).toBe(false);
        });

        it("should trigger check-in when step threshold reached", async () => {
            const stopCheck = controller.createStopCheck();

            // Mock the registry to respond with CONTINUE
            const respondSpy = spyOn(registry, "requestCheckIn").mockResolvedValue({ type: "CONTINUE" });

            // Simulate 5 steps (equals threshold)
            const steps = Array(5).fill({ toolCalls: [] });
            const shouldStop = await stopCheck(steps);

            expect(respondSpy).toHaveBeenCalled();
            expect(shouldStop).toBe(false);
        });

        it("should return true and set aborted when STOP received", async () => {
            const stopCheck = controller.createStopCheck();

            // Mock STOP response
            spyOn(registry, "requestCheckIn").mockResolvedValue({
                type: "STOP",
                reason: "Wrong direction"
            });

            const steps = Array(5).fill({ toolCalls: [] });
            const shouldStop = await stopCheck(steps);

            expect(shouldStop).toBe(true);
            expect(controller.isAborted()).toBe(true);
            expect(controller.getAbortReason()).toBe("Wrong direction");
        });

        it("should queue correction and continue when CORRECT received", async () => {
            const stopCheck = controller.createStopCheck();

            // Mock CORRECT response
            spyOn(registry, "requestCheckIn").mockResolvedValue({
                type: "CORRECT",
                message: "Focus on error handling"
            });

            const steps = Array(5).fill({ toolCalls: [] });
            const shouldStop = await stopCheck(steps);

            expect(shouldStop).toBe(false);
            expect(controller.isAborted()).toBe(false);

            // Correction should be queued
            const corrections = controller.getPendingCorrections();
            expect(corrections).toEqual(["Focus on error handling"]);
        });

        it("should extract tool names from steps", async () => {
            const stopCheck = controller.createStopCheck();

            // Mock to return CONTINUE immediately
            spyOn(registry, "requestCheckIn").mockResolvedValue({ type: "CONTINUE" });

            const steps = [
                { toolCalls: [{ toolName: "read_file" }, { toolName: "write_file" }] },
                { toolCalls: [{ toolName: "bash" }] },
                { toolCalls: [] },
                { toolCalls: [{ toolName: "read_file" }] }, // Duplicate
                { toolCalls: [{ toolName: "grep" }] },
            ];

            await stopCheck(steps);

            const recentTools = controller.getRecentToolCalls();
            expect(recentTools).toContain("read_file");
            expect(recentTools).toContain("write_file");
            expect(recentTools).toContain("bash");
            expect(recentTools).toContain("grep");
        });

        it("should return true immediately if already aborted", async () => {
            const stopCheck = controller.createStopCheck();

            // First call - get aborted
            spyOn(registry, "requestCheckIn").mockResolvedValue({
                type: "STOP",
                reason: "Abort"
            });

            const steps = Array(5).fill({ toolCalls: [] });
            await stopCheck(steps);

            // Second call - should return true immediately without check-in
            const requestSpy = spyOn(registry, "requestCheckIn");
            requestSpy.mockClear();

            const shouldStop = await stopCheck(Array(10).fill({ toolCalls: [] }));

            expect(shouldStop).toBe(true);
            // requestCheckIn should NOT be called again
            expect(requestSpy).not.toHaveBeenCalled();
        });
    });

    describe("getPendingCorrections", () => {
        it("should return empty array when no corrections", () => {
            const corrections = controller.getPendingCorrections();
            expect(corrections).toEqual([]);
        });

        it("should clear corrections after getting them", async () => {
            const stopCheck = controller.createStopCheck();

            spyOn(registry, "requestCheckIn").mockResolvedValue({
                type: "CORRECT",
                message: "Fix this"
            });

            await stopCheck(Array(5).fill({ toolCalls: [] }));

            // First call gets the correction
            const first = controller.getPendingCorrections();
            expect(first).toEqual(["Fix this"]);

            // Second call should be empty
            const second = controller.getPendingCorrections();
            expect(second).toEqual([]);
        });
    });

    describe("recordToolCalls", () => {
        it("should track tool calls", () => {
            controller.recordToolCalls(["tool1", "tool2"]);
            expect(controller.getRecentToolCalls()).toContain("tool1");
            expect(controller.getRecentToolCalls()).toContain("tool2");
        });

        it("should limit to 10 most recent tools", () => {
            // Add 15 unique tools
            for (let i = 0; i < 15; i++) {
                controller.recordToolCalls([`tool${i}`]);
            }

            const recent = controller.getRecentToolCalls();
            expect(recent.length).toBe(10);
            // Should have tools 5-14 (most recent)
            expect(recent).toContain("tool14");
            expect(recent).not.toContain("tool0");
        });
    });
});

describe("PairModeAbortError", () => {
    it("should create error with reason", () => {
        const error = new PairModeAbortError("Task cancelled");
        expect(error.name).toBe("PairModeAbortError");
        expect(error.reason).toBe("Task cancelled");
        expect(error.message).toContain("Task cancelled");
    });

    it("should create error without reason", () => {
        const error = new PairModeAbortError();
        expect(error.name).toBe("PairModeAbortError");
        expect(error.reason).toBeUndefined();
        expect(error.message).toBe("Delegation stopped by supervisor");
    });
});
