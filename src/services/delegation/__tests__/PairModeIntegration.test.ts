import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { PairModeController, PairModeAbortError } from "../PairModeController";
import { PairModeRegistry } from "../PairModeRegistry";
import type { PairModeConfig, PairModeAction } from "../types";

/**
 * Integration tests for pair mode delegation flow.
 * These tests verify the end-to-end communication between:
 * - PairModeController (runs in delegated agent)
 * - PairModeRegistry (coordinates check-ins)
 */
describe("Pair Mode Integration", () => {
    const delegatorPubkey = "delegator-pubkey";
    const agentPubkey = "agent-pubkey";
    const agentSlug = "test-delegated-agent";
    const config: Required<PairModeConfig> = {
        stepThreshold: 3,
        checkInTimeoutMs: 5000,
    };

    let batchId: string;
    let registry: PairModeRegistry;
    let controller: PairModeController;

    beforeEach(() => {
        // Reset singleton to ensure clean state
        PairModeRegistry.resetInstance();
        // Use unique batchId for each test to avoid state pollution
        batchId = `integration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        registry = PairModeRegistry.getInstance();
        registry.registerPairDelegation(batchId, delegatorPubkey, config, [agentPubkey]);
        controller = new PairModeController(batchId, agentPubkey, agentSlug, config);
    });

    afterEach(() => {
        // Clean up the delegation after each test
        registry.cleanup(batchId);
    });

    describe("Full delegation flow with CONTINUE", () => {
        it("should complete multiple check-ins with CONTINUE responses", async () => {
            const stopCheck = controller.createStopCheck();

            // Simulate delegator responding CONTINUE to all check-ins
            registry.on(`${batchId}:checkin`, () => {
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, { type: "CONTINUE" });
                }, 10);
            });

            // First batch of steps (3) - should trigger check-in
            const steps1 = Array(3).fill({ toolCalls: [{ toolName: "read_file" }] });
            const stop1 = await stopCheck(steps1);
            expect(stop1).toBe(false);
            expect(controller.isAborted()).toBe(false);

            // Second batch of steps (6 total) - should trigger another check-in
            const steps2 = Array(6).fill({ toolCalls: [{ toolName: "write_file" }] });
            const stop2 = await stopCheck(steps2);
            expect(stop2).toBe(false);
            expect(controller.isAborted()).toBe(false);

            // Third batch (9 total) - another check-in
            const steps3 = Array(9).fill({ toolCalls: [{ toolName: "bash" }] });
            const stop3 = await stopCheck(steps3);
            expect(stop3).toBe(false);

            // Verify check-in history
            const history = registry.getCheckInHistory(batchId);
            expect(history.length).toBe(3);
            expect(history.every(h => h.action.type === "CONTINUE")).toBe(true);
        });
    });

    describe("Full delegation flow with STOP", () => {
        it("should abort execution when delegator sends STOP", async () => {
            const stopCheck = controller.createStopCheck();

            // Delegator will CONTINUE on first check-in, STOP on second
            let checkInCount = 0;
            registry.on(`${batchId}:checkin`, () => {
                checkInCount++;
                setTimeout(() => {
                    if (checkInCount === 1) {
                        registry.respondToCheckIn(batchId, { type: "CONTINUE" });
                    } else {
                        registry.respondToCheckIn(batchId, {
                            type: "STOP",
                            reason: "Going in wrong direction",
                        });
                    }
                }, 10);
            });

            // First check-in - should continue
            const steps1 = Array(3).fill({ toolCalls: [] });
            const stop1 = await stopCheck(steps1);
            expect(stop1).toBe(false);

            // Second check-in - should stop
            const steps2 = Array(6).fill({ toolCalls: [] });
            const stop2 = await stopCheck(steps2);
            expect(stop2).toBe(true);
            expect(controller.isAborted()).toBe(true);
            expect(controller.getAbortReason()).toBe("Going in wrong direction");

            // Any subsequent call should immediately return true
            const stop3 = await stopCheck(Array(10).fill({ toolCalls: [] }));
            expect(stop3).toBe(true);
        });
    });

    describe("Full delegation flow with CORRECT", () => {
        it("should inject corrections and continue execution", async () => {
            const stopCheck = controller.createStopCheck();

            // Delegator will send CORRECT on first check-in, CONTINUE on second
            let checkInCount = 0;
            registry.on(`${batchId}:checkin`, () => {
                checkInCount++;
                setTimeout(() => {
                    if (checkInCount === 1) {
                        registry.respondToCheckIn(batchId, {
                            type: "CORRECT",
                            message: "Focus on error handling, not performance optimization",
                        });
                    } else {
                        registry.respondToCheckIn(batchId, { type: "CONTINUE" });
                    }
                }, 10);
            });

            // First check-in - should continue with correction
            const steps1 = Array(3).fill({ toolCalls: [] });
            const stop1 = await stopCheck(steps1);
            expect(stop1).toBe(false);

            // Should have pending correction
            const corrections = controller.getPendingCorrections();
            expect(corrections).toEqual(["Focus on error handling, not performance optimization"]);

            // Corrections should be cleared
            const empty = controller.getPendingCorrections();
            expect(empty).toEqual([]);

            // Second check-in - normal continue
            const steps2 = Array(6).fill({ toolCalls: [] });
            const stop2 = await stopCheck(steps2);
            expect(stop2).toBe(false);

            // No more corrections
            expect(controller.getPendingCorrections()).toEqual([]);
        });

        it("should accumulate multiple corrections", async () => {
            const stopCheck = controller.createStopCheck();

            // Delegator will send two CORRECT responses
            let checkInCount = 0;
            registry.on(`${batchId}:checkin`, () => {
                checkInCount++;
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, {
                        type: "CORRECT",
                        message: `Correction ${checkInCount}`,
                    });
                }, 10);
            });

            // First check-in
            await stopCheck(Array(3).fill({ toolCalls: [] }));
            // Don't consume corrections yet

            // Second check-in (without consuming first correction)
            await stopCheck(Array(6).fill({ toolCalls: [] }));

            // Should have both corrections
            const corrections = controller.getPendingCorrections();
            expect(corrections).toEqual(["Correction 1", "Correction 2"]);
        });
    });

    describe("Tool tracking across check-ins", () => {
        it("should track tool calls and include in check-in request", async () => {
            const stopCheck = controller.createStopCheck();

            let receivedRequest: unknown = null;
            registry.on(`${batchId}:checkin`, (req) => {
                receivedRequest = req;
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, { type: "CONTINUE" });
                }, 10);
            });

            // Steps with various tool calls
            const steps = [
                { toolCalls: [{ toolName: "read_file" }, { toolName: "grep" }] },
                { toolCalls: [{ toolName: "bash" }] },
                { toolCalls: [{ toolName: "write_file" }] },
            ];

            await stopCheck(steps);

            expect(receivedRequest).toBeDefined();
            const req = receivedRequest as { recentToolCalls: string[] };
            expect(req.recentToolCalls).toContain("read_file");
            expect(req.recentToolCalls).toContain("grep");
            expect(req.recentToolCalls).toContain("bash");
            expect(req.recentToolCalls).toContain("write_file");
        });
    });

    describe("Error handling", () => {
        it("should handle registry timeout gracefully", async () => {
            // Re-register with very short timeout
            registry.cleanup(batchId);
            registry.registerPairDelegation(batchId, delegatorPubkey, {
                stepThreshold: 3,
                checkInTimeoutMs: 50,
            }, [agentPubkey]);
            const shortTimeoutController = new PairModeController(
                batchId,
                agentPubkey,
                agentSlug,
                { stepThreshold: 3, checkInTimeoutMs: 50 }
            );

            const stopCheck = shortTimeoutController.createStopCheck();

            // Don't respond to check-in - let it timeout
            const steps = Array(3).fill({ toolCalls: [] });
            const stop = await stopCheck(steps);

            // Should continue (default on timeout)
            expect(stop).toBe(false);
            expect(shortTimeoutController.isAborted()).toBe(false);
        });
    });

    describe("Completion and cleanup", () => {
        it("should properly complete a delegation", async () => {
            const stopCheck = controller.createStopCheck();

            registry.on(`${batchId}:checkin`, () => {
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, { type: "CONTINUE" });
                }, 10);
            });

            // Run some steps with check-in
            await stopCheck(Array(3).fill({ toolCalls: [] }));

            // Complete the delegation
            registry.completeDelegation(batchId);

            const state = registry.getState(batchId);
            expect(state!.status).toBe("completed");

            // Cleanup
            registry.cleanup(batchId);
            expect(registry.isPairModeDelegation(batchId)).toBe(false);
        });
    });

    describe("PairModeAbortError usage", () => {
        it("should be usable for graceful abort handling", async () => {
            const stopCheck = controller.createStopCheck();

            registry.on(`${batchId}:checkin`, () => {
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, {
                        type: "STOP",
                        reason: "Task reassigned",
                    });
                }, 10);
            });

            // Trigger check-in
            const shouldStop = await stopCheck(Array(3).fill({ toolCalls: [] }));

            expect(shouldStop).toBe(true);

            // This is how AgentExecutor would handle it
            if (controller.isAborted()) {
                const error = new PairModeAbortError(controller.getAbortReason());
                expect(error.name).toBe("PairModeAbortError");
                expect(error.reason).toBe("Task reassigned");
                expect(error.message).toContain("Task reassigned");
            }
        });
    });
});
