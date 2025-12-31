import { beforeEach, describe, expect, it } from "bun:test";
import { RALRegistry } from "../RALRegistry";
import type { PendingDelegation, CompletedDelegation } from "../types";

describe("RALRegistry", () => {
  let registry: RALRegistry;
  const agentPubkey = "agent-pubkey-123";
  const agentPubkey2 = "agent-pubkey-456";
  const conversationId = "conv-123";
  const conversationId2 = "conv-456";

  beforeEach(() => {
    registry = RALRegistry.getInstance();
    // Clear any existing state
    registry.clear(agentPubkey, conversationId);
    registry.clear(agentPubkey, conversationId2);
    registry.clear(agentPubkey2, conversationId);
    registry.clear(agentPubkey2, conversationId2);
  });

  describe("singleton pattern", () => {
    it("should return same instance", () => {
      const instance1 = RALRegistry.getInstance();
      const instance2 = RALRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("create", () => {
    it("should create a new RAL entry and return ralNumber", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);
      expect(ralNumber).toBeDefined();
      expect(typeof ralNumber).toBe("number");
      expect(ralNumber).toBe(1); // First RAL in conversation should be 1

      const state = registry.getState(agentPubkey, conversationId);
      expect(state).toBeDefined();
      expect(state?.ralNumber).toBe(ralNumber);
      expect(state?.agentPubkey).toBe(agentPubkey);
      expect(state?.conversationId).toBe(conversationId);
      expect(state?.isStreaming).toBe(false);
      expect(state?.pendingDelegations).toEqual([]);
      expect(state?.completedDelegations).toEqual([]);
      expect(state?.queuedInjections).toEqual([]);
      expect(state?.createdAt).toBeDefined();
      expect(state?.lastActivityAt).toBeDefined();
    });

    it("should assign unique RAL IDs", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const state1 = registry.getRAL(agentPubkey, conversationId, ralNumber1);
      registry.clearRAL(agentPubkey, conversationId, ralNumber1);
      const ralNumber2 = registry.create(agentPubkey, conversationId);
      const state2 = registry.getRAL(agentPubkey, conversationId, ralNumber2);
      expect(state1?.id).not.toBe(state2?.id);
    });

    it("should create multiple RALs for same agent+conversation (not overwrite)", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId);
      expect(ralNumber1).not.toBe(ralNumber2);
      expect(ralNumber2).toBe(ralNumber1 + 1);

      // Both RALs should exist
      const ral1 = registry.getRAL(agentPubkey, conversationId, ralNumber1);
      const ral2 = registry.getRAL(agentPubkey, conversationId, ralNumber2);
      expect(ral1).toBeDefined();
      expect(ral2).toBeDefined();

      // getState returns the most recent (highest ralNumber)
      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.ralNumber).toBe(ralNumber2);
    });

    it("should isolate state between different conversations", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId2);

      // Both should be RAL #1 since they're in different conversations
      expect(ralNumber1).toBe(1);
      expect(ralNumber2).toBe(1);

      const state1 = registry.getState(agentPubkey, conversationId);
      const state2 = registry.getState(agentPubkey, conversationId2);

      expect(state1?.conversationId).toBe(conversationId);
      expect(state2?.conversationId).toBe(conversationId2);
    });
  });

  describe("getState and getRAL", () => {
    it("should return undefined for non-existent agent+conversation", () => {
      const state = registry.getState("nonexistent", conversationId);
      expect(state).toBeUndefined();
    });

    it("should return undefined for non-existent conversation", () => {
      registry.create(agentPubkey, conversationId);
      const state = registry.getState(agentPubkey, "nonexistent");
      expect(state).toBeUndefined();
    });

    it("should return state for existing agent+conversation", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);
      const state = registry.getState(agentPubkey, conversationId);
      expect(state).toBeDefined();
      expect(state?.ralNumber).toBe(ralNumber);
    });

    it("should get specific RAL by number", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId);

      const ral1 = registry.getRAL(agentPubkey, conversationId, ralNumber1);
      const ral2 = registry.getRAL(agentPubkey, conversationId, ralNumber2);

      expect(ral1?.ralNumber).toBe(ralNumber1);
      expect(ral2?.ralNumber).toBe(ralNumber2);
    });
  });

  describe("setStreaming", () => {
    it("should set streaming state", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);
      const initialState = registry.getState(agentPubkey, conversationId);
      const initialLastActivity = initialState?.lastActivityAt;

      registry.setStreaming(agentPubkey, conversationId, ralNumber, true);

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.isStreaming).toBe(true);
      expect(state?.lastActivityAt).toBeGreaterThanOrEqual(initialLastActivity!);
    });

    it("should handle setStreaming for non-existent RAL gracefully", () => {
      expect(() => {
        registry.setStreaming("nonexistent", conversationId, 1, true);
      }).not.toThrow();
    });

    it("should update lastActivityAt when streaming state changes", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);
      const initialState = registry.getState(agentPubkey, conversationId);
      const initialTime = initialState?.lastActivityAt;

      // Wait a bit to ensure timestamp difference
      const start = Date.now();
      while (Date.now() - start < 2) {
        // Small delay
      }

      registry.setStreaming(agentPubkey, conversationId, ralNumber, true);
      const updatedState = registry.getState(agentPubkey, conversationId);

      expect(updatedState?.lastActivityAt).toBeGreaterThan(initialTime!);
    });
  });

  describe("setPendingDelegations", () => {
    it("should set pending delegations", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-event-1",
          recipientPubkey: "recipient-1",
          prompt: "Do task 1",
        },
        {
          delegationConversationId: "del-event-2",
          recipientPubkey: "recipient-2",
          recipientSlug: "agent-2",
          prompt: "Do task 2",
        },
      ];

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.pendingDelegations).toEqual(pendingDelegations);
    });

    it("should create delegation event ID to RAL key mappings", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-event-1",
          recipientPubkey: "recipient-1",
          prompt: "Task 1",
        },
        {
          delegationConversationId: "del-event-2",
          recipientPubkey: "recipient-2",
          prompt: "Task 2",
        },
      ];

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      expect(registry.getRalKeyForDelegation("del-event-1")).toBeDefined();
      expect(registry.getRalKeyForDelegation("del-event-2")).toBeDefined();
    });

    it("should handle saveState for non-existent RAL gracefully", () => {
      const messages: ModelMessage[] = [{ role: "user", content: "Test" }];
      const delegations: PendingDelegation[] = [];

      expect(() => {
        registry.setPendingDelegations("nonexistent", conversationId, 1, delegations);
      }).not.toThrow();
    });

    it("should update lastActivityAt when saving state", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);
      const initialState = registry.getState(agentPubkey, conversationId);
      const initialTime = initialState?.lastActivityAt;

      // Small delay
      const start = Date.now();
      while (Date.now() - start < 2) {}

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, []);
      const updatedState = registry.getState(agentPubkey, conversationId);

      expect(updatedState?.lastActivityAt).toBeGreaterThan(initialTime!);
    });
  });

  describe("getRalKeyForDelegation", () => {
    it("should return undefined for non-existent delegation", () => {
      const key = registry.getRalKeyForDelegation("nonexistent");
      expect(key).toBeUndefined();
    });

    it("should return RAL key for registered delegation", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);
      const delegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-123",
          recipientPubkey: "recipient",
          prompt: "Task",
        },
      ];

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, delegations);

      expect(registry.getRalKeyForDelegation("del-123")).toBeDefined();
    });
  });

  describe("recordCompletion", () => {
    it("should record a delegation completion", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-event-1",
          recipientPubkey: "recipient-1",
          prompt: "Task 1",
        },
        {
          delegationConversationId: "del-event-2",
          recipientPubkey: "recipient-2",
          prompt: "Task 2",
        },
      ];

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      const completion: CompletedDelegation = {
        delegationConversationId: "del-event-1",
        recipientPubkey: "recipient-1",
        response: "Task completed",
        responseEventId: "response-123",
        completedAt: Date.now(),
      };

      const updatedState = registry.recordCompletion(completion);

      expect(updatedState).toBeDefined();
      expect(updatedState?.completedDelegations).toHaveLength(1);
      expect(updatedState?.completedDelegations[0]).toEqual(completion);
      expect(updatedState?.pendingDelegations).toHaveLength(1);
      expect(updatedState?.pendingDelegations[0].delegationConversationId).toBe("del-event-2");
    });

    it("should return undefined for non-existent delegation", () => {
      const completion: CompletedDelegation = {
        delegationConversationId: "nonexistent",
        recipientPubkey: "recipient-1",
        response: "Done",
        completedAt: Date.now(),
      };

      const result = registry.recordCompletion(completion);
      expect(result).toBeUndefined();
    });

    it("should update lastActivityAt when recording completion", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-123",
          recipientPubkey: "recipient",
          prompt: "Task",
        },
      ];
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      const initialState = registry.getState(agentPubkey, conversationId);
      const initialTime = initialState?.lastActivityAt;

      const start = Date.now();
      while (Date.now() - start < 2) {}

      const completion: CompletedDelegation = {
        delegationConversationId: "del-123",
        recipientPubkey: "recipient",
        response: "Done",
        completedAt: Date.now(),
      };

      const updatedState = registry.recordCompletion(completion);

      expect(updatedState?.lastActivityAt).toBeGreaterThan(initialTime!);
    });
  });

  describe("queueSystemMessage", () => {
    it("should queue a system message", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      registry.queueSystemMessage(agentPubkey, conversationId, ralNumber, "System message content");

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.queuedInjections).toHaveLength(1);
      expect(state?.queuedInjections[0].role).toBe("system");
      expect(state?.queuedInjections[0].content).toBe("System message content");
      expect(state?.queuedInjections[0].eventId).toBeUndefined();
      expect(state?.queuedInjections[0].queuedAt).toBeDefined();
    });

    it("should handle queueSystemMessage for non-existent RAL gracefully", () => {
      expect(() => {
        registry.queueSystemMessage("nonexistent", conversationId, 1, "Test");
      }).not.toThrow();
    });
  });

  describe("getAndConsumeInjections", () => {
    it("should return empty array for non-existent RAL", () => {
      const injections = registry.getAndConsumeInjections("nonexistent", conversationId, 1);
      expect(injections).toEqual([]);
    });

    it("should return and consume queued injections", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      registry.queueUserMessage(agentPubkey, conversationId, ralNumber, "User message");
      registry.queueSystemMessage(agentPubkey, conversationId, ralNumber, "System message");

      const injections = registry.getAndConsumeInjections(agentPubkey, conversationId, ralNumber);

      expect(injections).toHaveLength(2);
      expect(injections[0].role).toBe("user");
      expect(injections[0].content).toBe("User message");
      expect(injections[1].role).toBe("system");
      expect(injections[1].content).toBe("System message");

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.queuedInjections).toEqual([]);
    });

    it("should return copy of injections, not original array", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      registry.queueSystemMessage(agentPubkey, conversationId, ralNumber, "Test");

      const injections1 = registry.getAndConsumeInjections(agentPubkey, conversationId, ralNumber);
      const injections2 = registry.getAndConsumeInjections(agentPubkey, conversationId, ralNumber);

      expect(injections1).toHaveLength(1);
      expect(injections2).toEqual([]);
    });
  });

  describe("setCurrentTool", () => {
    it("should set current tool and toolStartedAt", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      registry.setCurrentTool(agentPubkey, conversationId, ralNumber, "read_path");

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.currentTool).toBe("read_path");
      expect(state?.toolStartedAt).toBeDefined();
    });

    it("should clear current tool when set to undefined", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      registry.setCurrentTool(agentPubkey, conversationId, ralNumber, "read_path");
      registry.setCurrentTool(agentPubkey, conversationId, ralNumber, undefined);

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.currentTool).toBeUndefined();
      expect(state?.toolStartedAt).toBeUndefined();
    });

    it("should handle setCurrentTool for non-existent RAL gracefully", () => {
      expect(() => {
        registry.setCurrentTool("nonexistent", conversationId, 1, "read_path");
      }).not.toThrow();
    });
  });

  describe("abort controller management", () => {
    it("should register and abort controller", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const controller = new AbortController();
      registry.registerAbortController(agentPubkey, conversationId, ralNumber, controller);

      expect(controller.signal.aborted).toBe(false);

      registry.abortCurrentTool(agentPubkey, conversationId);

      expect(controller.signal.aborted).toBe(true);
    });

    it("should handle abort without registered controller gracefully", () => {
      registry.create(agentPubkey, conversationId);

      expect(() => {
        registry.abortCurrentTool(agentPubkey, conversationId);
      }).not.toThrow();
    });

    it("should clear controller after abort", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const controller = new AbortController();
      registry.registerAbortController(agentPubkey, conversationId, ralNumber, controller);
      registry.abortCurrentTool(agentPubkey, conversationId);

      // Aborting again should not affect the already aborted controller
      expect(() => {
        registry.abortCurrentTool(agentPubkey, conversationId);
      }).not.toThrow();
    });
  });

  describe("clearRAL and clear", () => {
    it("should clear specific RAL state", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      registry.queueSystemMessage(agentPubkey, conversationId, ralNumber, "Test");

      registry.clearRAL(agentPubkey, conversationId, ralNumber);

      const ral = registry.getRAL(agentPubkey, conversationId, ralNumber);
      expect(ral).toBeUndefined();
    });

    it("should clear all RALs for a conversation", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId);

      registry.clear(agentPubkey, conversationId);

      expect(registry.getRAL(agentPubkey, conversationId, ralNumber1)).toBeUndefined();
      expect(registry.getRAL(agentPubkey, conversationId, ralNumber2)).toBeUndefined();
      expect(registry.getState(agentPubkey, conversationId)).toBeUndefined();
    });

    it("should clean up delegation mappings", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-pending-1",
          recipientPubkey: "recipient-1",
          prompt: "Task 1",
        },
      ];

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      expect(registry.getRalKeyForDelegation("del-pending-1")).toBeDefined();

      registry.clear(agentPubkey, conversationId);

      expect(registry.getRalKeyForDelegation("del-pending-1")).toBeUndefined();
    });

    it("should clear abort controllers", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const controller = new AbortController();
      registry.registerAbortController(agentPubkey, conversationId, ralNumber, controller);

      registry.clear(agentPubkey, conversationId);

      // Should not be able to abort after clear
      expect(() => {
        registry.abortCurrentTool(agentPubkey, conversationId);
      }).not.toThrow();
    });

    it("should handle clear for non-existent agent gracefully", () => {
      expect(() => {
        registry.clear("nonexistent", conversationId);
      }).not.toThrow();
    });
  });

  describe("conversation isolation", () => {
    it("should handle multiple conversations independently for same agent", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId2);

      registry.queueSystemMessage(agentPubkey, conversationId, ralNumber1, "Message for conversation 1");
      registry.queueSystemMessage(agentPubkey, conversationId2, ralNumber2, "Message for conversation 2");

      const state1 = registry.getState(agentPubkey, conversationId);
      const state2 = registry.getState(agentPubkey, conversationId2);

      expect(state1?.queuedInjections).toHaveLength(1);
      expect(state1?.queuedInjections[0].content).toBe("Message for conversation 1");

      expect(state2?.queuedInjections).toHaveLength(1);
      expect(state2?.queuedInjections[0].content).toBe("Message for conversation 2");
    });

    it("should clear one conversation without affecting others", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId2);

      registry.queueSystemMessage(agentPubkey, conversationId, ralNumber1, "Message 1");
      registry.queueSystemMessage(agentPubkey, conversationId2, ralNumber2, "Message 2");

      registry.clear(agentPubkey, conversationId);

      expect(registry.getState(agentPubkey, conversationId)).toBeUndefined();
      expect(registry.getState(agentPubkey, conversationId2)).toBeDefined();

      const state2 = registry.getState(agentPubkey, conversationId2);
      expect(state2?.queuedInjections).toHaveLength(1);
    });

    it("should track delegation completions per conversation", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId2);

      const delegations1: PendingDelegation[] = [
        {
          delegationConversationId: "del-conv1",
          recipientPubkey: "recipient-1",
          prompt: "Task for conv1",
        },
      ];
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber1, delegations1);

      const delegations2: PendingDelegation[] = [
        {
          delegationConversationId: "del-conv2",
          recipientPubkey: "recipient-2",
          prompt: "Task for conv2",
        },
      ];
      registry.setPendingDelegations(agentPubkey, conversationId2, ralNumber2, delegations2);

      // Complete delegation for conversation 1
      const completion: CompletedDelegation = {
        delegationConversationId: "del-conv1",
        recipientPubkey: "recipient-1",
        response: "Done",
        completedAt: Date.now(),
      };
      registry.recordCompletion(completion);

      // Conversation 1 should have completion
      const state1 = registry.getState(agentPubkey, conversationId);
      expect(state1?.completedDelegations).toHaveLength(1);
      expect(state1?.pendingDelegations).toHaveLength(0);

      // Conversation 2 should be unaffected
      const state2 = registry.getState(agentPubkey, conversationId2);
      expect(state2?.completedDelegations).toHaveLength(0);
      expect(state2?.pendingDelegations).toHaveLength(1);
    });
  });

  describe("concurrent RAL management", () => {
    it("should track multiple active RALs", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId);
      const ralNumber3 = registry.create(agentPubkey, conversationId);

      const activeRALs = registry.getActiveRALs(agentPubkey, conversationId);
      expect(activeRALs).toHaveLength(3);
      expect(activeRALs.map(r => r.ralNumber).sort()).toEqual([1, 2, 3]);
    });

    it("should inject messages to specific RALs", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId);

      const success = registry.injectToRAL(agentPubkey, conversationId, ralNumber1, "Hello from RAL 2");
      expect(success).toBe(true);

      const ral1 = registry.getRAL(agentPubkey, conversationId, ralNumber1);
      const ral2 = registry.getRAL(agentPubkey, conversationId, ralNumber2);

      expect(ral1?.queuedInjections).toHaveLength(1);
      expect(ral1?.queuedInjections[0].content).toBe("Hello from RAL 2");
      expect(ral2?.queuedInjections).toHaveLength(0);
    });

    it("should abort specific RAL without pending delegations", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId);
      const ralNumber2 = registry.create(agentPubkey, conversationId);

      const result = registry.abortRAL(agentPubkey, conversationId, ralNumber1);
      expect(result.success).toBe(true);

      expect(registry.getRAL(agentPubkey, conversationId, ralNumber1)).toBeUndefined();
      expect(registry.getRAL(agentPubkey, conversationId, ralNumber2)).toBeDefined();
    });

    it("should not abort RAL with pending delegations", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const delegations: PendingDelegation[] = [
        { delegationConversationId: "del-1", recipientPubkey: "recipient", prompt: "Task" },
      ];
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, delegations);

      const result = registry.abortRAL(agentPubkey, conversationId, ralNumber);
      expect(result.success).toBe(false);
      expect(result.reason).toContain("pending delegation");
    });
  });

  describe("edge cases", () => {
    it("should handle empty pending delegations array", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, []);

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.pendingDelegations).toEqual([]);
    });

    it("should handle pending delegation without optional fields", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const delegation: PendingDelegation = {
        delegationConversationId: "del-123",
        recipientPubkey: "recipient",
        prompt: "Task",
      };

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [delegation]);

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.pendingDelegations[0]).toEqual(delegation);
    });

    it("should handle completed delegation without optional fields", () => {
      const ralNumber = registry.create(agentPubkey, conversationId);

      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-123",
          recipientPubkey: "recipient",
          prompt: "Task",
        },
      ];
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      const completion: CompletedDelegation = {
        delegationConversationId: "del-123",
        recipientPubkey: "recipient",
        response: "Done",
        completedAt: Date.now(),
      };

      const updatedState = registry.recordCompletion(completion);

      expect(updatedState?.completedDelegations[0]).toEqual(completion);
    });
  });

  describe("RAL pause/release", () => {
    it("should pause other RALs when a new RAL starts", () => {
      // Create RAL #1
      const ral1 = registry.create(agentPubkey, conversationId);
      expect(ral1).toBe(1);

      // Create RAL #2
      const ral2 = registry.create(agentPubkey, conversationId);
      expect(ral2).toBe(2);

      // RAL #2 pauses RAL #1
      const pausedCount = registry.pauseOtherRALs(agentPubkey, conversationId, ral2);
      expect(pausedCount).toBe(1);

      // Verify RAL #1 is paused
      expect(registry.isPaused(agentPubkey, conversationId, ral1)).toBe(true);
      expect(registry.isPaused(agentPubkey, conversationId, ral2)).toBe(false);

      // Verify pause promise exists
      const pausePromise = registry.getPausePromise(agentPubkey, conversationId, ral1);
      expect(pausePromise).toBeDefined();
      expect(pausePromise).toBeInstanceOf(Promise);
    });

    it("should not pause RALs that are already paused", () => {
      // Create 3 RALs
      const ral1 = registry.create(agentPubkey, conversationId);
      const ral2 = registry.create(agentPubkey, conversationId);
      const ral3 = registry.create(agentPubkey, conversationId);

      // RAL #2 pauses all others (RAL #1 and RAL #3)
      const pausedByRal2 = registry.pauseOtherRALs(agentPubkey, conversationId, ral2);
      expect(pausedByRal2).toBe(2); // Both RAL #1 and RAL #3 paused

      // RAL #3 tries to pause - RAL #1 is already paused by RAL #2, so only RAL #2 should be pausable
      // But RAL #3 is also paused by RAL #2, so it shouldn't be able to pause anything
      // Wait - actually RAL #3 is the one calling pause, so it pauses RAL #2 (RAL #1 already paused)
      const pausedByRal3 = registry.pauseOtherRALs(agentPubkey, conversationId, ral3);
      expect(pausedByRal3).toBe(1); // Only RAL #2 paused (RAL #1 already paused by RAL #2)

      // Verify pause states
      const ral1State = registry.getRAL(agentPubkey, conversationId, ral1);
      const ral2State = registry.getRAL(agentPubkey, conversationId, ral2);
      expect(ral1State?.pausedByRalNumber).toBe(ral2);
      expect(ral2State?.pausedByRalNumber).toBe(ral3);
    });

    it("should release paused RALs", async () => {
      // Create RAL #1 and #2
      const ral1 = registry.create(agentPubkey, conversationId);
      const ral2 = registry.create(agentPubkey, conversationId);

      // RAL #2 pauses RAL #1
      registry.pauseOtherRALs(agentPubkey, conversationId, ral2);
      expect(registry.isPaused(agentPubkey, conversationId, ral1)).toBe(true);

      // Get the pause promise
      const pausePromise = registry.getPausePromise(agentPubkey, conversationId, ral1);

      // Set up a flag to track when promise resolves
      let resolved = false;
      pausePromise!.then(() => { resolved = true; });

      // Release
      const releasedCount = registry.releaseOtherRALs(agentPubkey, conversationId, ral2);
      expect(releasedCount).toBe(1);

      // Wait for microtask queue
      await Promise.resolve();

      // Verify RAL #1 is no longer paused
      expect(registry.isPaused(agentPubkey, conversationId, ral1)).toBe(false);
      expect(registry.getPausePromise(agentPubkey, conversationId, ral1)).toBeUndefined();
      expect(resolved).toBe(true);
    });

    it("should only release RALs paused by the releasing RAL", () => {
      // Create 3 RALs
      const ral1 = registry.create(agentPubkey, conversationId);
      const ral2 = registry.create(agentPubkey, conversationId);
      const ral3 = registry.create(agentPubkey, conversationId);

      // RAL #2 pauses RAL #1
      registry.pauseOtherRALs(agentPubkey, conversationId, ral2);
      // RAL #3 pauses RAL #2 (RAL #1 already paused)
      registry.pauseOtherRALs(agentPubkey, conversationId, ral3);

      // RAL #3 releases - should only release RAL #2
      const releasedCount = registry.releaseOtherRALs(agentPubkey, conversationId, ral3);
      expect(releasedCount).toBe(1);

      // RAL #1 should still be paused (by RAL #2)
      expect(registry.isPaused(agentPubkey, conversationId, ral1)).toBe(true);
      expect(registry.isPaused(agentPubkey, conversationId, ral2)).toBe(false);
    });

    it("should not pause self", () => {
      const ral1 = registry.create(agentPubkey, conversationId);

      // Try to pause when only one RAL exists
      const pausedCount = registry.pauseOtherRALs(agentPubkey, conversationId, ral1);
      expect(pausedCount).toBe(0);
      expect(registry.isPaused(agentPubkey, conversationId, ral1)).toBe(false);
    });

    it("should handle pause/release across different conversations independently", () => {
      // Create RALs in two conversations
      const ral1Conv1 = registry.create(agentPubkey, conversationId);
      const ral2Conv1 = registry.create(agentPubkey, conversationId);
      const ral1Conv2 = registry.create(agentPubkey, conversationId2);
      const ral2Conv2 = registry.create(agentPubkey, conversationId2);

      // Pause in conversation 1
      registry.pauseOtherRALs(agentPubkey, conversationId, ral2Conv1);

      // Verify only conversation 1's RAL #1 is paused
      expect(registry.isPaused(agentPubkey, conversationId, ral1Conv1)).toBe(true);
      expect(registry.isPaused(agentPubkey, conversationId2, ral1Conv2)).toBe(false);

      // Release in conversation 1
      registry.releaseOtherRALs(agentPubkey, conversationId, ral2Conv1);
      expect(registry.isPaused(agentPubkey, conversationId, ral1Conv1)).toBe(false);
    });
  });
});
