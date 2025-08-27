import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createMockNDKEvent } from "@/test-utils/bun-mocks";
import type { ExecutionQueueManager } from "../../executionQueue";
import { PHASES } from "../../phases";
import type { Conversation } from "../../types";
import { PhaseManager } from "../PhaseManager";

const { VERIFICATION } = PHASES;

describe("PhaseManager", () => {
  let phaseManager: PhaseManager;
  let mockConversation: Conversation;
  let mockQueueManager: any;

  beforeEach(() => {
    // Create mock queue manager
    mockQueueManager = {
      requestExecution: mock(() => Promise.resolve({ granted: true })),
      releaseExecution: mock(() => {}),
      on: mock(() => {}),
      off: mock(() => {}),
      emit: mock(() => {}),
    };

    phaseManager = new PhaseManager(mockQueueManager);

    const mockEvent = createMockNDKEvent({
      id: "event1",
      content: "Test message",
    });

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
        lastUpdated: Date.now(),
      },
    };
  });


  describe("transition", () => {
    const context = {
      agentPubkey: "pubkey123",
      agentName: "Test Agent",
      message: "Transitioning phase",
    };

    it("should allow same-phase delegation", async () => {
      const result = await phaseManager.transition(mockConversation, PHASES.CHAT, context);

      expect(result.success).toBe(true);
      expect(result.transition).toBeDefined();
      expect(result.transition?.from).toBe(PHASES.CHAT);
      expect(result.transition?.to).toBe(PHASES.CHAT);
    });

    it("should allow valid phase transition", async () => {
      const result = await phaseManager.transition(mockConversation, PHASES.PLAN, context);

      expect(result.success).toBe(true);
      expect(result.transition).toBeDefined();
      expect(result.transition?.from).toBe(PHASES.CHAT);
      expect(result.transition?.to).toBe(PHASES.PLAN);
    });

    it("should allow all phase transitions", async () => {
      // Test a previously "invalid" transition that's now valid
      mockConversation.phase = PHASES.EXECUTE;
      const result = await phaseManager.transition(mockConversation, PHASES.VERIFICATION, context);

      expect(result.success).toBe(true);
      expect(result.transition).toBeDefined();
      expect(result.transition?.to).toBe(PHASES.VERIFICATION);
    });

    describe("EXECUTE phase with queue", () => {
      it("should request execution permission when entering EXECUTE", async () => {
        mockQueueManager.requestExecution.mockResolvedValue({
          granted: true,
        });

        const result = await phaseManager.transition(mockConversation, PHASES.EXECUTE, context);

        expect(mockQueueManager.requestExecution).toHaveBeenCalledWith("conv1", "pubkey123");
        expect(result.success).toBe(true);
      });

      it("should queue conversation when execution not granted", async () => {
        mockQueueManager.requestExecution.mockResolvedValue({
          granted: false,
          queuePosition: 2,
          waitTime: 120,
        });

        const result = await phaseManager.transition(mockConversation, PHASES.EXECUTE, context);

        expect(result.success).toBe(false);
        expect(result.queued).toBe(true);
        expect(result.queuePosition).toBe(2);
        expect(result.estimatedWait).toBe(120);
        expect(result.queueMessage).toContain("Queue Position: 2");
      });

      it("should release execution when leaving EXECUTE", async () => {
        mockConversation.phase = PHASES.EXECUTE;

        await phaseManager.transition(mockConversation, PHASES.CHAT, context);

        expect(mockQueueManager.releaseExecution).toHaveBeenCalledWith("conv1", "phase_transition");
      });
    });
  });


  describe("setupQueueListeners", () => {
    it("should setup event listeners on queue manager", () => {
      const onLockAcquired = mock(() => {});
      const onTimeout = mock(() => {});
      const onTimeoutWarning = mock(() => {});

      phaseManager.setupQueueListeners(onLockAcquired, onTimeout, onTimeoutWarning);

      expect(mockQueueManager.on).toHaveBeenCalledWith("lock-acquired", onLockAcquired);
      expect(mockQueueManager.on).toHaveBeenCalledWith("timeout", onTimeout);
      expect(mockQueueManager.on).toHaveBeenCalledWith("timeout-warning", onTimeoutWarning);
    });

    it("should not setup listeners if no queue manager", () => {
      const phaseManagerNoQueue = new PhaseManager();
      const onLockAcquired = mock(() => {});
      const onTimeout = mock(() => {});
      const onTimeoutWarning = mock(() => {});

      // Should not throw
      phaseManagerNoQueue.setupQueueListeners(onLockAcquired, onTimeout, onTimeoutWarning);
    });
  });
});
