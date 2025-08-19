import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { PhaseManager } from "../PhaseManager";
import { PHASES } from "../../phases";
import type { Conversation } from "../../types";
import type { ExecutionQueueManager } from "../../executionQueue";
import { NDKEvent } from "@nostr-dev-kit/ndk";

const { VERIFICATION } = PHASES;

describe("PhaseManager", () => {
    let phaseManager: PhaseManager;
    let mockConversation: Conversation;
    let mockQueueManager: jest.Mocked<ExecutionQueueManager>;

    beforeEach(() => {
        // Create mock queue manager
        mockQueueManager = {
            requestExecution: jest.fn(),
            releaseExecution: jest.fn(),
            on: jest.fn(),
            off: jest.fn(),
            emit: jest.fn()
        } as any;

        phaseManager = new PhaseManager(mockQueueManager);

        const mockEvent = new NDKEvent();
        mockEvent.id = "event1";
        mockEvent.content = "Test message";

        mockConversation = {
            id: "conv1",
            title: "Test Conversation",
            phase: PHASES.CHAT,
            history: [mockEvent],
            agentStates: new Map(),
            phaseStartedAt: Date.now(),
            metadata: {},
            phaseTransitions: [],
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now()
            }
        };
    });

    describe("canTransition", () => {
        it("should allow valid transitions from CHAT", () => {
            expect(phaseManager.canTransition(PHASES.CHAT, PHASES.PLAN)).toBe(true);
            expect(phaseManager.canTransition(PHASES.CHAT, PHASES.REFLECTION)).toBe(true);
            expect(phaseManager.canTransition(PHASES.CHAT, PHASES.EXECUTE)).toBe(true);
        });

        it("should allow valid transitions from PLAN", () => {
            expect(phaseManager.canTransition(PHASES.PLAN, PHASES.CHAT)).toBe(true);
            expect(phaseManager.canTransition(PHASES.PLAN, PHASES.EXECUTE)).toBe(true);
            expect(phaseManager.canTransition(PHASES.PLAN, PHASES.REFLECTION)).toBe(true);
        });

        it("should allow valid transitions from REFLECTION", () => {
            expect(phaseManager.canTransition(PHASES.REFLECTION, PHASES.CHAT)).toBe(true);
            expect(phaseManager.canTransition(PHASES.REFLECTION, PHASES.PLAN)).toBe(true);
            expect(phaseManager.canTransition(PHASES.REFLECTION, PHASES.EXECUTE)).toBe(true);
        });

        it("should allow valid transitions from EXECUTE", () => {
            expect(phaseManager.canTransition(PHASES.EXECUTE, PHASES.CHAT)).toBe(true);
            expect(phaseManager.canTransition(PHASES.EXECUTE, PHASES.REFLECTION)).toBe(true);
            expect(phaseManager.canTransition(PHASES.EXECUTE, PHASES.PLAN)).toBe(true);
        });

        it("should allow all valid phase transitions", () => {
            // Now all phases can transition to all others
            expect(phaseManager.canTransition(PHASES.CHAT, PHASES.EXECUTE)).toBe(true);
            expect(phaseManager.canTransition(PHASES.EXECUTE, PHASES.VERIFICATION)).toBe(true);
            expect(phaseManager.canTransition(PHASES.VERIFICATION, PHASES.CHAT)).toBe(true);
        });
    });

    describe("transition", () => {
        const context = {
            agentPubkey: "pubkey123",
            agentName: "Test Agent",
            message: "Transitioning phase"
        };

        it("should allow same-phase handoff", async () => {
            const result = await phaseManager.transition(
                mockConversation,
                PHASES.CHAT,
                context
            );

            expect(result.success).toBe(true);
            expect(result.transition).toBeDefined();
            expect(result.transition?.from).toBe(PHASES.CHAT);
            expect(result.transition?.to).toBe(PHASES.CHAT);
        });

        it("should allow valid phase transition", async () => {
            const result = await phaseManager.transition(
                mockConversation,
                PHASES.PLAN,
                context
            );

            expect(result.success).toBe(true);
            expect(result.transition).toBeDefined();
            expect(result.transition?.from).toBe(PHASES.CHAT);
            expect(result.transition?.to).toBe(PHASES.PLAN);
        });

        it("should allow all phase transitions", async () => {
            // Test a previously "invalid" transition that's now valid
            mockConversation.phase = PHASES.EXECUTE;
            const result = await phaseManager.transition(
                mockConversation,
                PHASES.VERIFICATION,
                context
            );

            expect(result.success).toBe(true);
            expect(result.transition).toBeDefined();
            expect(result.transition?.to).toBe(PHASES.VERIFICATION);
        });

        describe("EXECUTE phase with queue", () => {
            it("should request execution permission when entering EXECUTE", async () => {
                mockQueueManager.requestExecution.mockResolvedValue({
                    granted: true
                });

                const result = await phaseManager.transition(
                    mockConversation,
                    PHASES.EXECUTE,
                    context
                );

                expect(mockQueueManager.requestExecution).toHaveBeenCalledWith(
                    "conv1",
                    "pubkey123"
                );
                expect(result.success).toBe(true);
            });

            it("should queue conversation when execution not granted", async () => {
                mockQueueManager.requestExecution.mockResolvedValue({
                    granted: false,
                    queuePosition: 2,
                    waitTime: 120
                });

                const result = await phaseManager.transition(
                    mockConversation,
                    PHASES.EXECUTE,
                    context
                );

                expect(result.success).toBe(false);
                expect(result.queued).toBe(true);
                expect(result.queuePosition).toBe(2);
                expect(result.estimatedWait).toBe(120);
                expect(result.queueMessage).toContain("Queue Position: 2");
            });

            it("should release execution when leaving EXECUTE", async () => {
                mockConversation.phase = PHASES.EXECUTE;

                await phaseManager.transition(
                    mockConversation,
                    PHASES.CHAT,
                    context
                );

                expect(mockQueueManager.releaseExecution).toHaveBeenCalledWith(
                    "conv1",
                    "User request"
                );
            });
        });
    });

    describe("getPhaseRules", () => {
        it("should return rules for CHAT phase", () => {
            const rules = phaseManager.getPhaseRules(PHASES.CHAT);
            expect(rules.canTransitionTo).toContain(PHASES.PLAN);
            expect(rules.canTransitionTo).toContain(PHASES.REFLECTION);
            expect(rules.canTransitionTo).toContain(PHASES.EXECUTE);
            expect(rules.description).toContain("Open discussion");
        });

        it("should return rules for PLAN phase", () => {
            const rules = phaseManager.getPhaseRules(PHASES.PLAN);
            expect(rules.canTransitionTo).toContain(PHASES.CHAT);
            expect(rules.canTransitionTo).toContain(PHASES.EXECUTE);
            expect(rules.canTransitionTo).toContain(PHASES.REFLECTION);
            expect(rules.description).toContain("Planning");
        });

        it("should return rules for REFLECTION phase", () => {
            const rules = phaseManager.getPhaseRules(PHASES.REFLECTION);
            expect(rules.canTransitionTo).toContain(PHASES.CHAT);
            expect(rules.canTransitionTo).toContain(PHASES.PLAN);
            expect(rules.canTransitionTo).toContain(PHASES.EXECUTE);
            expect(rules.description).toContain("Review");
        });

        it("should return rules for EXECUTE phase", () => {
            const rules = phaseManager.getPhaseRules(PHASES.EXECUTE);
            expect(rules.canTransitionTo).toContain(PHASES.CHAT);
            expect(rules.canTransitionTo).toContain(PHASES.REFLECTION);
            expect(rules.canTransitionTo).toContain(PHASES.PLAN);
            expect(rules.description).toContain("Implementation");
        });
    });

    describe("setupQueueListeners", () => {
        it("should setup event listeners on queue manager", () => {
            const onLockAcquired = jest.fn();
            const onTimeout = jest.fn();
            const onTimeoutWarning = jest.fn();

            phaseManager.setupQueueListeners(
                onLockAcquired,
                onTimeout,
                onTimeoutWarning
            );

            expect(mockQueueManager.on).toHaveBeenCalledWith('lock-acquired', onLockAcquired);
            expect(mockQueueManager.on).toHaveBeenCalledWith('timeout', onTimeout);
            expect(mockQueueManager.on).toHaveBeenCalledWith('timeout-warning', onTimeoutWarning);
        });

        it("should not setup listeners if no queue manager", () => {
            const phaseManagerNoQueue = new PhaseManager();
            const onLockAcquired = jest.fn();
            const onTimeout = jest.fn();
            const onTimeoutWarning = jest.fn();

            // Should not throw
            phaseManagerNoQueue.setupQueueListeners(
                onLockAcquired,
                onTimeout,
                onTimeoutWarning
            );
        });
    });
});