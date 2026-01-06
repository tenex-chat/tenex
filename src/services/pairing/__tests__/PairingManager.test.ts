import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { PairingManager } from "../PairingManager";
import type { PairingConfig } from "../types";

// Mock getNDK
const mockSubscription = {
  on: mock(() => {}),
  stop: mock(() => {}),
};

const mockNDK = {
  subscribe: mock(() => mockSubscription),
};

mock.module("@/nostr/ndkClient", () => ({
  getNDK: () => mockNDK,
}));

// Mock RALRegistry - comprehensive mock
const mockQueueSystemMessage = mock(() => {});
const mockQueueUserMessage = mock(() => {});
mock.module("@/services/ral", () => ({
  RALRegistry: class MockRALRegistry {
    static instance: MockRALRegistry | undefined;
    static getInstance() {
      if (!MockRALRegistry.instance) {
        MockRALRegistry.instance = new MockRALRegistry();
      }
      return MockRALRegistry.instance;
    }
    create(_agentPubkey: string, _conversationId: string) { return 1; }
    clear(_agentPubkey: string, _conversationId: string) {}
    clearAll() {}
    findResumableRAL() { return null; }
    getState() { return null; }
    getRAL() { return undefined; }
    queueUserMessage = mockQueueUserMessage;
    queueSystemMessage = mockQueueSystemMessage;
    setPendingDelegations() {}
    setCompletedDelegations() {}
    setStreaming() {}
    setCurrentTool() {}
    recordCompletion() {}
    findDelegation() { return undefined; }
    getConversationPendingDelegations() { return []; }
    getConversationCompletedDelegations() { return []; }
    shouldWakeUpExecution() { return true; }
    registerAbortController() {}
    getAndConsumeInjections() { return []; }
    getRalKeyForDelegation() { return undefined; }
    abortCurrentTool() {}
    getActiveRALs() { return []; }
    findStateWaitingForDelegation() { return undefined; }
    clearRAL() {}
  },
}));

describe("PairingManager", () => {
  let pairingManager: PairingManager;
  let resumeCallback: ReturnType<typeof mock>;
  const supervisorPubkey = "supervisor-pubkey-123";
  const conversationId = "conv-123";
  const delegationId = "delegation-event-123";

  beforeEach(() => {
    // Reset mocks
    mockSubscription.on.mockClear();
    mockSubscription.stop.mockClear();
    mockNDK.subscribe.mockClear();
    mockQueueSystemMessage.mockClear();
    mockQueueUserMessage.mockClear();

    // Create fresh PairingManager with mock callback
    resumeCallback = mock(() => Promise.resolve());
    pairingManager = new PairingManager(resumeCallback);
  });

  describe("constructor", () => {
    it("should create instance with resume callback", () => {
      expect(pairingManager).toBeDefined();
    });
  });

  describe("startPairing", () => {
    it("should start pairing and create subscription", () => {
      const config: PairingConfig = {
        delegationId,
        recipientPubkey: "recipient-pubkey",
        recipientSlug: "implementer",
        interval: 5,
      };

      pairingManager.startPairing(
        delegationId,
        config,
        supervisorPubkey,
        conversationId,
        1
      );

      expect(pairingManager.hasPairing(delegationId)).toBe(true);
      expect(mockNDK.subscribe).toHaveBeenCalledWith(
        {
          kinds: [1],
          "#e": [delegationId],
        },
        { closeOnEose: false }
      );
      expect(mockSubscription.on).toHaveBeenCalledWith("event", expect.any(Function));
    });

    it("should stop existing pairing before starting new one", () => {
      const config: PairingConfig = {
        delegationId,
        recipientPubkey: "recipient-pubkey",
        interval: 5,
      };

      // Start first pairing
      pairingManager.startPairing(
        delegationId,
        config,
        supervisorPubkey,
        conversationId,
        1
      );

      // Start second pairing with same delegationId
      pairingManager.startPairing(
        delegationId,
        { ...config, interval: 10 },
        supervisorPubkey,
        conversationId,
        2
      );

      // Should have stopped first subscription
      expect(mockSubscription.stop).toHaveBeenCalled();
      expect(pairingManager.hasPairing(delegationId)).toBe(true);
    });

    it("should track multiple independent pairings", () => {
      const delegationId2 = "delegation-event-456";

      const config1: PairingConfig = {
        delegationId,
        recipientPubkey: "recipient-1",
        interval: 5,
      };

      const config2: PairingConfig = {
        delegationId: delegationId2,
        recipientPubkey: "recipient-2",
        interval: 3,
      };

      pairingManager.startPairing(delegationId, config1, supervisorPubkey, conversationId, 1);
      pairingManager.startPairing(delegationId2, config2, supervisorPubkey, conversationId, 2);

      expect(pairingManager.hasPairing(delegationId)).toBe(true);
      expect(pairingManager.hasPairing(delegationId2)).toBe(true);
    });
  });

  describe("stopPairing", () => {
    it("should stop pairing and cleanup subscription", () => {
      const config: PairingConfig = {
        delegationId,
        recipientPubkey: "recipient-pubkey",
        interval: 5,
      };

      pairingManager.startPairing(
        delegationId,
        config,
        supervisorPubkey,
        conversationId,
        1
      );

      pairingManager.stopPairing(delegationId);

      expect(pairingManager.hasPairing(delegationId)).toBe(false);
      expect(mockSubscription.stop).toHaveBeenCalled();
    });

    it("should handle stopping non-existent pairing gracefully", () => {
      expect(() => {
        pairingManager.stopPairing("non-existent");
      }).not.toThrow();
    });
  });

  describe("hasPairing", () => {
    it("should return false for non-existent pairing", () => {
      expect(pairingManager.hasPairing("non-existent")).toBe(false);
    });

    it("should return true for active pairing", () => {
      const config: PairingConfig = {
        delegationId,
        recipientPubkey: "recipient-pubkey",
        interval: 5,
      };

      pairingManager.startPairing(
        delegationId,
        config,
        supervisorPubkey,
        conversationId,
        1
      );

      expect(pairingManager.hasPairing(delegationId)).toBe(true);
    });
  });

  describe("getPairingState", () => {
    it("should return undefined for non-existent pairing", () => {
      expect(pairingManager.getPairingState("non-existent")).toBeUndefined();
    });

    it("should return state for active pairing", () => {
      const config: PairingConfig = {
        delegationId,
        recipientPubkey: "recipient-pubkey",
        recipientSlug: "implementer",
        interval: 5,
      };

      pairingManager.startPairing(
        delegationId,
        config,
        supervisorPubkey,
        conversationId,
        1
      );

      const state = pairingManager.getPairingState(delegationId);

      expect(state).toBeDefined();
      expect(state?.delegationId).toBe(delegationId);
      expect(state?.supervisorPubkey).toBe(supervisorPubkey);
      expect(state?.supervisorConversationId).toBe(conversationId);
      expect(state?.supervisorRalNumber).toBe(1);
      expect(state?.recipientSlug).toBe("implementer");
      expect(state?.interval).toBe(5);
      expect(state?.eventBuffer).toEqual([]);
      expect(state?.eventsSinceLastCheckpoint).toBe(0);
      expect(state?.totalEventsSeen).toBe(0);
      expect(state?.checkpointNumber).toBe(0);
      expect(state?.createdAt).toBeDefined();
    });
  });

  describe("stopAll", () => {
    it("should stop all active pairings", () => {
      const config1: PairingConfig = {
        delegationId,
        recipientPubkey: "recipient-1",
        interval: 5,
      };

      const config2: PairingConfig = {
        delegationId: "delegation-2",
        recipientPubkey: "recipient-2",
        interval: 3,
      };

      pairingManager.startPairing(delegationId, config1, supervisorPubkey, conversationId, 1);
      pairingManager.startPairing("delegation-2", config2, supervisorPubkey, conversationId, 2);

      pairingManager.stopAll();

      expect(pairingManager.hasPairing(delegationId)).toBe(false);
      expect(pairingManager.hasPairing("delegation-2")).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should return empty status when no pairings", () => {
      const status = pairingManager.getStatus();

      expect(status.activePairings).toBe(0);
      expect(status.delegationIds).toEqual([]);
    });

    it("should return status with active pairings", () => {
      const config: PairingConfig = {
        delegationId,
        recipientPubkey: "recipient-pubkey",
        interval: 5,
      };

      pairingManager.startPairing(
        delegationId,
        config,
        supervisorPubkey,
        conversationId,
        1
      );

      const status = pairingManager.getStatus();

      expect(status.activePairings).toBe(1);
      expect(status.delegationIds).toHaveLength(1);
      // delegationIds are truncated to 8 chars
      expect(status.delegationIds[0]).toBe(delegationId.substring(0, 8));
    });
  });
});
