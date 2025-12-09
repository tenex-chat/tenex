import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { PairModeRegistry } from "../PairModeRegistry";
import type { PairModeConfig, PairCheckInRequest, PairModeAction } from "../types";

describe("PairModeRegistry", () => {
    const delegatorPubkey = "delegator-pubkey-abc";

    let batchId: string;
    let registry: PairModeRegistry;

    beforeEach(() => {
        // Reset singleton to ensure clean state
        PairModeRegistry.resetInstance();
        // Use unique batchId for each test to avoid state pollution
        batchId = `registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        registry = PairModeRegistry.getInstance();
    });

    afterEach(() => {
        // Clean up the delegation after each test
        registry.cleanup(batchId);
    });

    describe("getInstance", () => {
        it("should return the same instance", () => {
            const instance1 = PairModeRegistry.getInstance();
            const instance2 = PairModeRegistry.getInstance();
            expect(instance1).toBe(instance2);
        });
    });

    describe("registerPairDelegation", () => {
        it("should register a delegation with default config", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);

            expect(registry.isPairModeDelegation(batchId)).toBe(true);

            const state = registry.getState(batchId);
            expect(state).toBeDefined();
            expect(state!.batchId).toBe(batchId);
            expect(state!.delegatorPubkey).toBe(delegatorPubkey);
            expect(state!.mode).toBe("pair");
            expect(state!.status).toBe("running");
            expect(state!.config.stepThreshold).toBe(10);
            expect(state!.config.checkInTimeoutMs).toBe(60000);
        });

        it("should register with custom config", () => {
            const config: Partial<PairModeConfig> = {
                stepThreshold: 5,
                checkInTimeoutMs: 30000,
            };

            registry.registerPairDelegation(batchId, delegatorPubkey, config);

            const state = registry.getState(batchId);
            expect(state!.config.stepThreshold).toBe(5);
            expect(state!.config.checkInTimeoutMs).toBe(30000);
        });
    });

    describe("isPairModeDelegation", () => {
        it("should return false for unknown batch", () => {
            expect(registry.isPairModeDelegation("unknown-batch")).toBe(false);
        });

        it("should return true for registered batch", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);
            expect(registry.isPairModeDelegation(batchId)).toBe(true);
        });
    });

    describe("getState", () => {
        it("should return undefined for unknown batch", () => {
            expect(registry.getState("unknown-batch")).toBeUndefined();
        });

        it("should return state for registered batch", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);

            const state = registry.getState(batchId);
            expect(state).toBeDefined();
            expect(state!.batchId).toBe(batchId);
        });
    });

    describe("shouldCheckIn", () => {
        it("should return false for unknown batch", () => {
            expect(registry.shouldCheckIn("unknown", 10)).toBe(false);
        });

        it("should return false when below threshold", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 10 });

            expect(registry.shouldCheckIn(batchId, 5)).toBe(false);
            expect(registry.shouldCheckIn(batchId, 9)).toBe(false);
        });

        it("should return true when at or above threshold", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 10 });

            expect(registry.shouldCheckIn(batchId, 10)).toBe(true);
            expect(registry.shouldCheckIn(batchId, 15)).toBe(true);
        });

        it("should return false when not in running status", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 10 });
            registry.abortDelegation(batchId, "test abort");

            expect(registry.shouldCheckIn(batchId, 20)).toBe(false);
        });
    });

    describe("requestCheckIn and respondToCheckIn", () => {
        // Helper to create request with current batchId
        const createRequest = (): PairCheckInRequest => ({
            batchId,
            delegatedAgentPubkey: "agent-pubkey",
            delegatedAgentSlug: "test-agent",
            stepNumber: 10,
            totalSteps: 0,
            recentToolCalls: ["read_file", "write_file"],
        });

        it("should emit checkin event and wait for response", async () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 10 });

            let eventEmitted = false;
            registry.on(`${batchId}:checkin`, (req: PairCheckInRequest) => {
                eventEmitted = true;
                expect(req.batchId).toBe(batchId);
                expect(req.stepNumber).toBe(10);

                // Simulate delegator response
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, { type: "CONTINUE" });
                }, 10);
            });

            const action = await registry.requestCheckIn(createRequest());

            expect(eventEmitted).toBe(true);
            expect(action.type).toBe("CONTINUE");
        });

        it("should update state on CONTINUE", async () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 10 });

            registry.on(`${batchId}:checkin`, () => {
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, { type: "CONTINUE" });
                }, 10);
            });

            await registry.requestCheckIn(createRequest());

            const state = registry.getState(batchId);
            expect(state!.status).toBe("running");
            expect(state!.lastCheckInStep).toBe(10);
        });

        it("should update state on STOP", async () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 10 });

            registry.on(`${batchId}:checkin`, () => {
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, { type: "STOP", reason: "Test stop" });
                }, 10);
            });

            const action = await registry.requestCheckIn(createRequest());

            expect(action.type).toBe("STOP");
            if (action.type === "STOP") {
                expect(action.reason).toBe("Test stop");
            }

            const state = registry.getState(batchId);
            expect(state!.status).toBe("aborted");
        });

        it("should update state and store message on CORRECT", async () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 10 });

            registry.on(`${batchId}:checkin`, () => {
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, {
                        type: "CORRECT",
                        message: "Focus on error handling",
                    });
                }, 10);
            });

            const action = await registry.requestCheckIn(createRequest());

            expect(action.type).toBe("CORRECT");
            if (action.type === "CORRECT") {
                expect(action.message).toBe("Focus on error handling");
            }

            const state = registry.getState(batchId);
            expect(state!.status).toBe("running");
            expect(state!.correctionMessages).toContain("Focus on error handling");
        });

        it("should timeout and return CONTINUE after timeout", async () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, {
                stepThreshold: 10,
                checkInTimeoutMs: 50, // Short timeout for test
            });

            // Don't respond - let it timeout
            const action = await registry.requestCheckIn(createRequest());

            expect(action.type).toBe("CONTINUE");

            const state = registry.getState(batchId);
            expect(state!.status).toBe("running");
        });

        it("should throw error for unknown batch", async () => {
            await expect(registry.requestCheckIn({
                ...createRequest(),
                batchId: "unknown-batch",
            })).rejects.toThrow("No pair delegation found");
        });

        it("should warn when responding to non-existent check-in", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);
            // Should not throw, just warn
            registry.respondToCheckIn(batchId, { type: "CONTINUE" });
        });
    });

    describe("getCorrectionMessages", () => {
        it("should return empty array for unknown batch", () => {
            const messages = registry.getCorrectionMessages("unknown-batch");
            expect(messages).toEqual([]);
        });

        it("should return and clear correction messages", async () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 10 });

            registry.on(`${batchId}:checkin`, () => {
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, {
                        type: "CORRECT",
                        message: "Fix this issue",
                    });
                }, 10);
            });

            await registry.requestCheckIn({
                batchId,
                delegatedAgentPubkey: "agent",
                stepNumber: 10,
                totalSteps: 0,
                recentToolCalls: [],
            });

            // First call gets the messages
            const messages = registry.getCorrectionMessages(batchId);
            expect(messages).toEqual(["Fix this issue"]);

            // Second call should be empty
            const empty = registry.getCorrectionMessages(batchId);
            expect(empty).toEqual([]);
        });
    });

    describe("completeDelegation", () => {
        it("should mark delegation as completed", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);

            let completeEmitted = false;
            registry.on(`${batchId}:complete`, () => {
                completeEmitted = true;
            });

            registry.completeDelegation(batchId);

            const state = registry.getState(batchId);
            expect(state!.status).toBe("completed");
            expect(completeEmitted).toBe(true);
        });

        it("should do nothing for unknown batch", () => {
            // Should not throw
            registry.completeDelegation("unknown-batch");
        });
    });

    describe("abortDelegation", () => {
        it("should mark delegation as aborted", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);

            let abortEmitted = false;
            let emittedReason: string | undefined;
            registry.on(`${batchId}:aborted`, ({ reason }: { reason?: string }) => {
                abortEmitted = true;
                emittedReason = reason;
            });

            registry.abortDelegation(batchId, "Test abort reason");

            const state = registry.getState(batchId);
            expect(state!.status).toBe("aborted");
            expect(abortEmitted).toBe(true);
            expect(emittedReason).toBe("Test abort reason");
        });

        it("should reject pending check-in on abort", async () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 10 });

            // Start a check-in but abort before responding
            const checkInPromise = registry.requestCheckIn({
                batchId,
                delegatedAgentPubkey: "agent",
                stepNumber: 10,
                totalSteps: 0,
                recentToolCalls: [],
            });

            // Abort while check-in is pending
            setTimeout(() => {
                registry.abortDelegation(batchId, "Abort during check-in");
            }, 10);

            await expect(checkInPromise).rejects.toThrow("Delegation aborted");
        });
    });

    describe("getCheckInHistory", () => {
        it("should return empty array for unknown batch", () => {
            const history = registry.getCheckInHistory("unknown-batch");
            expect(history).toEqual([]);
        });

        it("should track check-in history", async () => {
            registry.registerPairDelegation(batchId, delegatorPubkey, { stepThreshold: 5 });

            registry.on(`${batchId}:checkin`, () => {
                setTimeout(() => {
                    registry.respondToCheckIn(batchId, { type: "CONTINUE" });
                }, 10);
            });

            await registry.requestCheckIn({
                batchId,
                delegatedAgentPubkey: "agent",
                stepNumber: 5,
                totalSteps: 0,
                recentToolCalls: [],
            });

            const history = registry.getCheckInHistory(batchId);
            expect(history.length).toBe(1);
            expect(history[0].action.type).toBe("CONTINUE");
            expect(history[0].stepNumber).toBe(5);
        });
    });

    describe("cleanup", () => {
        it("should remove delegation state", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);

            expect(registry.isPairModeDelegation(batchId)).toBe(true);

            registry.cleanup(batchId);

            expect(registry.isPairModeDelegation(batchId)).toBe(false);
            expect(registry.getState(batchId)).toBeUndefined();
            expect(registry.getCheckInHistory(batchId)).toEqual([]);
        });
    });

    describe("findDelegationByAgent", () => {
        it("should return undefined when no active delegations", () => {
            const state = registry.findDelegationByAgent("some-agent");
            expect(state).toBeUndefined();
        });

        it("should return running delegation", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);

            const state = registry.findDelegationByAgent("any-agent");
            expect(state).toBeDefined();
            expect(state!.batchId).toBe(batchId);
        });

        it("should not return completed delegation", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);
            registry.completeDelegation(batchId);

            const state = registry.findDelegationByAgent("any-agent");
            expect(state).toBeUndefined();
        });

        it("should not return aborted delegation", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);
            registry.abortDelegation(batchId);

            const state = registry.findDelegationByAgent("any-agent");
            expect(state).toBeUndefined();
        });
    });

    describe("recordStep", () => {
        it("should not throw for unknown batch", () => {
            // Should not throw
            registry.recordStep("unknown-batch", 5);
        });

        it("should record step for running delegation", () => {
            registry.registerPairDelegation(batchId, delegatorPubkey);

            // Should not throw
            registry.recordStep(batchId, 5);
        });
    });
});
