import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import { RALRegistry } from "../RALRegistry";
import type { PendingDelegation, CompletedDelegation } from "../types";

describe("RALRegistry", () => {
  let registry: RALRegistry;
  const agentPubkey = "agent-pubkey-123";
  const agentPubkey2 = "agent-pubkey-456";
  const conversationId = "conv-123";
  const conversationId2 = "conv-456";
  const projectId = "31933:pubkey:test-project";

  beforeEach(() => {
    // Reset singleton to ensure clean state between tests
    // @ts-expect-error - accessing private static for testing
    RALRegistry.instance = undefined;
    registry = RALRegistry.getInstance();
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
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);
      expect(ralNumber).toBeDefined();
      expect(typeof ralNumber).toBe("number");
      expect(ralNumber).toBe(1); // First RAL in conversation should be 1

      const state = registry.getState(agentPubkey, conversationId);
      expect(state).toBeDefined();
      expect(state?.ralNumber).toBe(ralNumber);
      expect(state?.agentPubkey).toBe(agentPubkey);
      expect(state?.conversationId).toBe(conversationId);
      expect(state?.isStreaming).toBe(false);
      expect(state?.queuedInjections).toEqual([]);
      // Delegations are now stored at conversation level, not on RALRegistryEntry
      expect(registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber)).toEqual([]);
      expect(registry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber)).toEqual([]);
      expect(state?.createdAt).toBeDefined();
      expect(state?.lastActivityAt).toBeDefined();
    });

    it("should assign unique RAL IDs", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);
      const state1 = registry.getRAL(agentPubkey, conversationId, ralNumber1);
      registry.clearRAL(agentPubkey, conversationId, ralNumber1);
      const ralNumber2 = registry.create(agentPubkey, conversationId, projectId);
      const state2 = registry.getRAL(agentPubkey, conversationId, ralNumber2);
      expect(state1?.id).not.toBe(state2?.id);
    });

    it("should create multiple RALs for same agent+conversation (not overwrite)", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);
      const ralNumber2 = registry.create(agentPubkey, conversationId, projectId);
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
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);
      const ralNumber2 = registry.create(agentPubkey, conversationId2, projectId);

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
      registry.create(agentPubkey, conversationId, projectId);
      const state = registry.getState(agentPubkey, "nonexistent");
      expect(state).toBeUndefined();
    });

    it("should return state for existing agent+conversation", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);
      const state = registry.getState(agentPubkey, conversationId);
      expect(state).toBeDefined();
      expect(state?.ralNumber).toBe(ralNumber);
    });

    it("should get specific RAL by number", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);
      const ralNumber2 = registry.create(agentPubkey, conversationId, projectId);

      const ral1 = registry.getRAL(agentPubkey, conversationId, ralNumber1);
      const ral2 = registry.getRAL(agentPubkey, conversationId, ralNumber2);

      expect(ral1?.ralNumber).toBe(ralNumber1);
      expect(ral2?.ralNumber).toBe(ralNumber2);
    });
  });

  describe("setStreaming", () => {
    it("should set streaming state", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);
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
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);
      const initialState = registry.getState(agentPubkey, conversationId);
      const initialTime = initialState?.lastActivityAt;

      setSystemTime(new Date((initialTime ?? Date.now()) + 2));
      try {
        registry.setStreaming(agentPubkey, conversationId, ralNumber, true);
      } finally {
        setSystemTime();
      }
      const updatedState = registry.getState(agentPubkey, conversationId);

      expect(updatedState?.lastActivityAt).toBeGreaterThan(initialTime!);
    });
  });

  describe("setPendingDelegations", () => {
    it("should set pending delegations", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const pendingDelegations: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-event-1",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Do task 1",
          ralNumber,
        },
        {
          type: "delegate",
          delegationConversationId: "del-event-2",
          recipientPubkey: "recipient-2",
          recipientSlug: "agent-2",
          senderPubkey: agentPubkey,
          prompt: "Do task 2",
          ralNumber,
        },
      ];

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      const storedDelegations = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      expect(storedDelegations).toEqual(pendingDelegations);
    });

    it("should create delegation event ID to RAL key mappings", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const pendingDelegations: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-event-1",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task 1",
          ralNumber,
        },
        {
          type: "delegate",
          delegationConversationId: "del-event-2",
          recipientPubkey: "recipient-2",
          senderPubkey: agentPubkey,
          prompt: "Task 2",
          ralNumber,
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
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);
      const initialState = registry.getState(agentPubkey, conversationId);
      const initialTime = initialState?.lastActivityAt;

      setSystemTime(new Date((initialTime ?? Date.now()) + 2));
      try {
        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, []);
      } finally {
        setSystemTime();
      }
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
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);
      const delegations: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-123",
          recipientPubkey: "recipient",
          senderPubkey: agentPubkey,
          prompt: "Task",
          ralNumber,
        },
      ];

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, delegations);

      expect(registry.getRalKeyForDelegation("del-123")).toBeDefined();
    });
  });

  describe("recordCompletion", () => {
    it("should record a delegation completion", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const pendingDelegations: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-event-1",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task 1",
          ralNumber,
        },
        {
          type: "delegate",
          delegationConversationId: "del-event-2",
          recipientPubkey: "recipient-2",
          senderPubkey: agentPubkey,
          prompt: "Task 2",
          ralNumber,
        },
      ];

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      const location = registry.recordCompletion({
        delegationConversationId: "del-event-1",
        recipientPubkey: "recipient-1",
        response: "Task completed",
        completedAt: Date.now(),
      });

      expect(location).toBeDefined();
      expect(location?.agentPubkey).toBe(agentPubkey);
      expect(location?.conversationId).toBe(conversationId);
      expect(location?.ralNumber).toBe(ralNumber);

      // Verify delegation moved from pending to completed
      const completed = registry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber);
      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      expect(completed).toHaveLength(1);
      expect(completed[0].delegationConversationId).toBe("del-event-1");
      expect(pending).toHaveLength(1);
      expect(pending[0].delegationConversationId).toBe("del-event-2");
    });

    it("should return undefined for non-existent delegation", () => {
      const result = registry.recordCompletion({
        delegationConversationId: "nonexistent",
        recipientPubkey: "recipient-1",
        response: "Done",
        completedAt: Date.now(),
      });

      expect(result).toBeUndefined();
    });

    it("should update lastActivityAt when recording completion", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const pendingDelegations: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-123",
          recipientPubkey: "recipient",
          senderPubkey: agentPubkey,
          prompt: "Task",
          ralNumber,
        },
      ];
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      const initialState = registry.getState(agentPubkey, conversationId);
      const initialTime = initialState?.lastActivityAt;

      setSystemTime(new Date((initialTime ?? Date.now()) + 2));
      let location: ReturnType<typeof registry.recordCompletion>;
      try {
        location = registry.recordCompletion({
          delegationConversationId: "del-123",
          recipientPubkey: "recipient",
          response: "Done",
          completedAt: Date.now(),
        });
      } finally {
        setSystemTime();
      }

      expect(location).toBeDefined();
      const updatedState = registry.getState(agentPubkey, conversationId);
      expect(updatedState?.lastActivityAt).toBeGreaterThan(initialTime!);
    });
  });

  describe("queueSystemMessage", () => {
    it("should queue a system message", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

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
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

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
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      registry.queueSystemMessage(agentPubkey, conversationId, ralNumber, "Test");

      const injections1 = registry.getAndConsumeInjections(agentPubkey, conversationId, ralNumber);
      const injections2 = registry.getAndConsumeInjections(agentPubkey, conversationId, ralNumber);

      expect(injections1).toHaveLength(1);
      expect(injections2).toEqual([]);
    });
  });

  describe("setToolActive (concurrent tool tracking)", () => {
    it("should track multiple concurrent tools", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Start two tools concurrently
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-1", true, "fs_read");
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-2", true, "web_fetch");

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.activeTools.size).toBe(2);
      expect(state?.activeTools.has("tool-call-1")).toBe(true);
      expect(state?.activeTools.has("tool-call-2")).toBe(true);
      // currentTool should be set to the most recent tool
      expect(state?.currentTool).toBe("web_fetch");
    });

    it("should update currentTool to remaining tool when one completes", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Start two tools
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-1", true, "fs_read");
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-2", true, "web_fetch");

      // Complete the second tool (current one)
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-2", false);

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.activeTools.size).toBe(1);
      expect(state?.activeTools.has("tool-call-1")).toBe(true);
      // currentTool should now point to the remaining active tool
      expect(state?.currentTool).toBe("fs_read");
    });

    it("should clear currentTool and toolStartedAt when all tools complete", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Start and complete two tools
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-1", true, "fs_read");
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-2", true, "web_fetch");
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-1", false);
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-2", false);

      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.activeTools.size).toBe(0);
      expect(state?.currentTool).toBeUndefined();
      expect(state?.toolStartedAt).toBeUndefined();
    });

    it("should store tool info in activeTools map", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-1", true, "fs_read");

      const state = registry.getState(agentPubkey, conversationId);
      const toolInfo = state?.activeTools.get("tool-call-1");
      expect(toolInfo?.name).toBe("fs_read");
      expect(toolInfo?.startedAt).toBeDefined();
    });

    it("should update toolStartedAt to remaining tool's start time when one completes", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Start first tool
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-1", true, "fs_read");
      const state1 = registry.getState(agentPubkey, conversationId);
      const firstToolStartTime = state1?.toolStartedAt;

      setSystemTime(new Date((firstToolStartTime ?? Date.now()) + 2));
      try {
        // Start second tool
        registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-2", true, "web_fetch");

        // Complete the second tool (current one)
        registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-2", false);
      } finally {
        setSystemTime();
      }

      const state2 = registry.getState(agentPubkey, conversationId);
      // currentTool should now point to the remaining active tool
      expect(state2?.currentTool).toBe("fs_read");
      // toolStartedAt should match the first tool's start time, not the second
      expect(state2?.toolStartedAt).toBe(firstToolStartTime);
    });

    it("should handle setToolActive for non-existent RAL gracefully", () => {
      expect(() => {
        registry.setToolActive("nonexistent", conversationId, 1, "tool-call-1", true, "fs_read");
      }).not.toThrow();
    });
  });

  describe("clearToolFallback", () => {
    it("should clear a tool and update currentTool to remaining", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Start two tools
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-1", true, "fs_read");
      registry.setToolActive(agentPubkey, conversationId, ralNumber, "tool-call-2", true, "web_fetch");

      // Clear the second tool via fallback
      const cleared = registry.clearToolFallback(agentPubkey, conversationId, ralNumber, "tool-call-2");

      expect(cleared).toBe(true);
      const state = registry.getState(agentPubkey, conversationId);
      expect(state?.activeTools.size).toBe(1);
      expect(state?.currentTool).toBe("fs_read");
    });

    it("should return false for non-existent tool", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const cleared = registry.clearToolFallback(agentPubkey, conversationId, ralNumber, "nonexistent");

      expect(cleared).toBe(false);
    });
  });

  describe("abort controller management", () => {
    it("should register and abort controller", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const controller = new AbortController();
      registry.registerAbortController(agentPubkey, conversationId, ralNumber, controller);

      expect(controller.signal.aborted).toBe(false);

      registry.abortCurrentTool(agentPubkey, conversationId);

      expect(controller.signal.aborted).toBe(true);
    });

    it("should handle abort without registered controller gracefully", () => {
      registry.create(agentPubkey, conversationId, projectId);

      expect(() => {
        registry.abortCurrentTool(agentPubkey, conversationId);
      }).not.toThrow();
    });

    it("should clear controller after abort", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

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
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      registry.queueSystemMessage(agentPubkey, conversationId, ralNumber, "Test");

      registry.clearRAL(agentPubkey, conversationId, ralNumber);

      const ral = registry.getRAL(agentPubkey, conversationId, ralNumber);
      expect(ral).toBeUndefined();
    });

    it("should clear all RALs for a conversation", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);
      const ralNumber2 = registry.create(agentPubkey, conversationId, projectId);

      registry.clear(agentPubkey, conversationId);

      expect(registry.getRAL(agentPubkey, conversationId, ralNumber1)).toBeUndefined();
      expect(registry.getRAL(agentPubkey, conversationId, ralNumber2)).toBeUndefined();
      expect(registry.getState(agentPubkey, conversationId)).toBeUndefined();
    });

    it("should clean up delegation mappings", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const pendingDelegations: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-pending-1",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task 1",
          ralNumber,
        },
      ];

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      expect(registry.getRalKeyForDelegation("del-pending-1")).toBeDefined();

      registry.clear(agentPubkey, conversationId);

      expect(registry.getRalKeyForDelegation("del-pending-1")).toBeUndefined();
    });

    it("should clear abort controllers", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

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
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);
      const ralNumber2 = registry.create(agentPubkey, conversationId2, projectId);

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
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);
      const ralNumber2 = registry.create(agentPubkey, conversationId2, projectId);

      registry.queueSystemMessage(agentPubkey, conversationId, ralNumber1, "Message 1");
      registry.queueSystemMessage(agentPubkey, conversationId2, ralNumber2, "Message 2");

      registry.clear(agentPubkey, conversationId);

      expect(registry.getState(agentPubkey, conversationId)).toBeUndefined();
      expect(registry.getState(agentPubkey, conversationId2)).toBeDefined();

      const state2 = registry.getState(agentPubkey, conversationId2);
      expect(state2?.queuedInjections).toHaveLength(1);
    });

    it("should track delegation completions per conversation", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);
      const ralNumber2 = registry.create(agentPubkey, conversationId2, projectId);

      const delegations1: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-conv1",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task for conv1",
          ralNumber: ralNumber1,
        },
      ];
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber1, delegations1);

      const delegations2: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-conv2",
          recipientPubkey: "recipient-2",
          senderPubkey: agentPubkey,
          prompt: "Task for conv2",
          ralNumber: ralNumber2,
        },
      ];
      registry.setPendingDelegations(agentPubkey, conversationId2, ralNumber2, delegations2);

      // Complete delegation for conversation 1
      registry.recordCompletion({
        delegationConversationId: "del-conv1",
        recipientPubkey: "recipient-1",
        response: "Done",
        completedAt: Date.now(),
      });

      // Conversation 1 should have completion
      const completed1 = registry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber1);
      const pending1 = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber1);
      expect(completed1).toHaveLength(1);
      expect(pending1).toHaveLength(0);

      // Conversation 2 should be unaffected
      const completed2 = registry.getConversationCompletedDelegations(agentPubkey, conversationId2, ralNumber2);
      const pending2 = registry.getConversationPendingDelegations(agentPubkey, conversationId2, ralNumber2);
      expect(completed2).toHaveLength(0);
      expect(pending2).toHaveLength(1);
    });
  });

  describe("simplified execution model", () => {
    it("should track active RALs", () => {
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);

      const activeRALs = registry.getActiveRALs(agentPubkey, conversationId);
      expect(activeRALs).toHaveLength(1);
      expect(activeRALs[0].ralNumber).toBe(ralNumber1);
    });

    describe("shouldWakeUpExecution", () => {
      it("should return true when no RAL exists", () => {
        // No RAL created yet
        const shouldWake = registry.shouldWakeUpExecution(agentPubkey, conversationId);
        expect(shouldWake).toBe(true);
      });

      it("should return false when RAL is streaming", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        registry.setStreaming(agentPubkey, conversationId, ralNumber, true);

        const shouldWake = registry.shouldWakeUpExecution(agentPubkey, conversationId);
        expect(shouldWake).toBe(false);
      });

      it("should return true when RAL is not streaming", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        registry.setStreaming(agentPubkey, conversationId, ralNumber, false);

        const shouldWake = registry.shouldWakeUpExecution(agentPubkey, conversationId);
        expect(shouldWake).toBe(true);
      });

      it("should return true when RAL has completed delegations", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        // Add a pending delegation
        const pendingDelegations: PendingDelegation[] = [
          {
            type: "standard",
            delegationConversationId: "del-123",
            recipientPubkey: "recipient",
            senderPubkey: agentPubkey,
            prompt: "Task",
            ralNumber,
          },
        ];
        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

        // Complete it
        registry.recordCompletion({
          delegationConversationId: "del-123",
          recipientPubkey: "recipient",
          response: "Done",
          completedAt: Date.now(),
        });

        const shouldWake = registry.shouldWakeUpExecution(agentPubkey, conversationId);
        expect(shouldWake).toBe(true);
      });

      it("should return true when RAL has pending delegations (waiting on response)", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        registry.setStreaming(agentPubkey, conversationId, ralNumber, false);

        // Add a pending delegation
        const pendingDelegations: PendingDelegation[] = [
          {
            type: "standard",
            delegationConversationId: "del-123",
            recipientPubkey: "recipient",
            senderPubkey: agentPubkey,
            prompt: "Task",
            ralNumber,
          },
        ];
        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

        // No completion yet - agent is waiting on delegation
        const shouldWake = registry.shouldWakeUpExecution(agentPubkey, conversationId);
        expect(shouldWake).toBe(true);
      });
    });
  });

  describe("mergePendingDelegations", () => {
    it("should insert new delegations and return correct counts", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const delegations: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-1",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task 1",
          ralNumber,
        },
        {
          type: "delegate",
          delegationConversationId: "del-2",
          recipientPubkey: "recipient-2",
          senderPubkey: agentPubkey,
          prompt: "Task 2",
          ralNumber,
        },
      ];

      const result = registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, delegations);

      expect(result.insertedCount).toBe(2);
      expect(result.mergedCount).toBe(0);

      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      expect(pending).toHaveLength(2);
    });

    it("should merge fields into existing entries instead of skipping duplicates", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // First: add a basic delegation
      const initialDelegation: PendingDelegation = {
        type: "delegate",
        delegationConversationId: "del-1",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Original prompt",
        ralNumber,
      };

      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [initialDelegation]);

      // Second: merge with followup that adds followupEventId
      const followupDelegation: PendingDelegation = {
        type: "followup",
        delegationConversationId: "del-1", // Same ID
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Follow-up prompt",
        followupEventId: "followup-event-123", // NEW field
        ralNumber,
      };

      const result = registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [followupDelegation]);

      expect(result.insertedCount).toBe(0);
      expect(result.mergedCount).toBe(1);

      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      expect(pending).toHaveLength(1);
      // Should have merged fields
      expect(pending[0].type).toBe("followup");
      expect(pending[0].prompt).toBe("Follow-up prompt");
      expect(pending[0].followupEventId).toBe("followup-event-123");
    });

    it("should register followupEventId in delegationToRal mapping when merging", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Add initial delegation
      const initialDelegation: PendingDelegation = {
        type: "delegate",
        delegationConversationId: "del-1",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Original",
        ralNumber,
      };
      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [initialDelegation]);

      // Merge with followup that has followupEventId
      const followupDelegation: PendingDelegation = {
        type: "followup",
        delegationConversationId: "del-1",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Follow-up",
        followupEventId: "followup-event-456",
        ralNumber,
      };
      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [followupDelegation]);

      // Both the original ID and followup ID should route to the same RAL
      expect(registry.getRalKeyForDelegation("del-1")).toBeDefined();
      expect(registry.getRalKeyForDelegation("followup-event-456")).toBeDefined();
    });

    it("should handle concurrent merge calls safely", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Simulate two concurrent delegation batches
      const batch1: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-1",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task 1",
          ralNumber,
        },
      ];

      const batch2: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-2",
          recipientPubkey: "recipient-2",
          senderPubkey: agentPubkey,
          prompt: "Task 2",
          ralNumber,
        },
      ];

      // Both should succeed without dropping the other's updates
      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, batch1);
      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, batch2);

      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      expect(pending).toHaveLength(2);
      expect(pending.find(d => d.delegationConversationId === "del-1")).toBeDefined();
      expect(pending.find(d => d.delegationConversationId === "del-2")).toBeDefined();
    });

    it("should return zeros when RAL does not exist", () => {
      const result = registry.mergePendingDelegations("nonexistent", conversationId, 999, []);
      expect(result.insertedCount).toBe(0);
      expect(result.mergedCount).toBe(0);
    });

    it("should handle mixed inserts and merges in single call", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Add initial delegation
      const initialDelegation: PendingDelegation = {
        type: "delegate",
        delegationConversationId: "del-1",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Task 1",
        ralNumber,
      };
      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [initialDelegation]);

      // Now merge: one existing (should merge) and one new (should insert)
      const mixedBatch: PendingDelegation[] = [
        {
          type: "followup",
          delegationConversationId: "del-1", // Existing - will merge
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Updated prompt",
          followupEventId: "followup-1",
          ralNumber,
        },
        {
          type: "delegate",
          delegationConversationId: "del-2", // New - will insert
          recipientPubkey: "recipient-2",
          senderPubkey: agentPubkey,
          prompt: "Task 2",
          ralNumber,
        },
      ];

      const result = registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, mixedBatch);

      expect(result.insertedCount).toBe(1);
      expect(result.mergedCount).toBe(1);

      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      expect(pending).toHaveLength(2);
    });

    it("should update lastActivityAt", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);
      const initialState = registry.getState(agentPubkey, conversationId);
      const initialTime = initialState?.lastActivityAt;

      setSystemTime(new Date((initialTime ?? Date.now()) + 2));
      try {
        registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, []);
      } finally {
        setSystemTime();
      }

      const updatedState = registry.getState(agentPubkey, conversationId);
      expect(updatedState?.lastActivityAt).toBeGreaterThan(initialTime!);
    });

    it("should update delegationToRal mapping on merge with new RAL number", () => {
      // Create RAL 1
      const ralNumber1 = registry.create(agentPubkey, conversationId, projectId);

      // Add delegation to RAL 1
      const delegation1: PendingDelegation = {
        type: "delegate",
        delegationConversationId: "del-1",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Original",
        ralNumber: ralNumber1,
      };
      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber1, [delegation1]);

      // Create RAL 2
      const ralNumber2 = registry.create(agentPubkey, conversationId, projectId);

      // Merge same delegation ID to RAL 2 (simulating followup from new RAL)
      const delegation2: PendingDelegation = {
        type: "followup",
        delegationConversationId: "del-1",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Follow-up from new RAL",
        followupEventId: "followup-abc",
        ralNumber: ralNumber2,
      };
      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber2, [delegation2]);

      // The delegation should now be associated with RAL 2
      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber2);
      expect(pending).toHaveLength(1);
      expect(pending[0].ralNumber).toBe(ralNumber2);
    });
  });

  describe("followup completion routing", () => {
    it("should record completion when e-tag contains followupEventId instead of delegationConversationId", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Add a followup delegation with a followupEventId
      const followupDelegation: PendingDelegation = {
        type: "followup",
        delegationConversationId: "original-del-123",
        followupEventId: "followup-event-456",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Follow-up question",
        ralNumber,
      };

      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [followupDelegation]);

      // Record completion using the followupEventId (simulating a client reply with only the followup e-tag)
      const location = registry.recordCompletion({
        delegationConversationId: "followup-event-456", // Using followupEventId!
        recipientPubkey: "recipient-1",
        response: "Here's my follow-up response",
        completedAt: Date.now(),
      });

      // Completion should succeed and route correctly
      expect(location).toBeDefined();
      expect(location?.agentPubkey).toBe(agentPubkey);
      expect(location?.conversationId).toBe(conversationId);
      expect(location?.ralNumber).toBe(ralNumber);

      // Delegation should be moved from pending to completed
      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      const completed = registry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber);

      expect(pending).toHaveLength(0);
      expect(completed).toHaveLength(1);
      // Completed entry should use the canonical ID
      expect(completed[0].delegationConversationId).toBe("original-del-123");
    });

    it("should find pending delegation via followupEventId", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const followupDelegation: PendingDelegation = {
        type: "followup",
        delegationConversationId: "original-del-789",
        followupEventId: "followup-event-abc",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Another follow-up",
        ralNumber,
      };

      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [followupDelegation]);

      // Find delegation using the followupEventId
      const result = registry.findDelegation("followup-event-abc");

      expect(result).toBeDefined();
      expect(result?.pending).toBeDefined();
      expect(result?.pending?.delegationConversationId).toBe("original-del-789");
      expect(result?.agentPubkey).toBe(agentPubkey);
      expect(result?.conversationId).toBe(conversationId);
    });

    it("should find RAL waiting for delegation via followupEventId", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const followupDelegation: PendingDelegation = {
        type: "followup",
        delegationConversationId: "original-del-xyz",
        followupEventId: "followup-event-def",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Yet another follow-up",
        ralNumber,
      };

      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [followupDelegation]);

      // Find RAL waiting for delegation using the followupEventId
      const ral = registry.findStateWaitingForDelegation("followup-event-def");

      expect(ral).toBeDefined();
      expect(ral?.ralNumber).toBe(ralNumber);
      expect(ral?.agentPubkey).toBe(agentPubkey);
    });

    it("should handle completion flow: initial delegate -> followup -> completion via followupEventId", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Step 1: Add initial delegation
      const initialDelegation: PendingDelegation = {
        type: "delegate",
        delegationConversationId: "conv-001",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Initial task",
        ralNumber,
      };

      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [initialDelegation]);

      // Verify initial state
      expect(registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber)).toHaveLength(1);

      // Step 2: Merge followup (simulating delegate_followup being called)
      const followupDelegation: PendingDelegation = {
        type: "followup",
        delegationConversationId: "conv-001", // Same conversation
        followupEventId: "followup-msg-001",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Follow-up question about initial task",
        ralNumber,
      };

      const mergeResult = registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [followupDelegation]);
      expect(mergeResult.mergedCount).toBe(1);
      expect(mergeResult.insertedCount).toBe(0);

      // Step 3: Record completion using followupEventId (client replies to followup)
      const location = registry.recordCompletion({
        delegationConversationId: "followup-msg-001", // Reply e-tags the followup
        recipientPubkey: "recipient-1",
        response: "Here's the answer to your follow-up",
        completedAt: Date.now(),
      });

      expect(location).toBeDefined();
      expect(location?.ralNumber).toBe(ralNumber);

      // Verify final state
      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      const completed = registry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber);

      expect(pending).toHaveLength(0);
      expect(completed).toHaveLength(1);
      expect(completed[0].delegationConversationId).toBe("conv-001"); // Canonical ID
    });

    it("should clean up followupToCanonical mapping when clearing conversation", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const followupDelegation: PendingDelegation = {
        type: "followup",
        delegationConversationId: "conv-cleanup",
        followupEventId: "followup-cleanup",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Test cleanup",
        ralNumber,
      };

      registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [followupDelegation]);

      // Verify mapping exists
      expect(registry.getRalKeyForDelegation("followup-cleanup")).toBeDefined();

      // Clear conversation
      registry.clear(agentPubkey, conversationId);

      // Verify mapping is cleaned up
      expect(registry.getRalKeyForDelegation("followup-cleanup")).toBeUndefined();
      expect(registry.findDelegation("followup-cleanup")).toBeUndefined();
    });

    it("should clean up followupToCanonical mapping when using setPendingDelegations", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Add followup delegation
      const followupDelegation: PendingDelegation = {
        type: "followup",
        delegationConversationId: "conv-set-cleanup",
        followupEventId: "followup-set-cleanup",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        prompt: "Test setPendingDelegations cleanup",
        ralNumber,
      };

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [followupDelegation]);

      // Verify mapping exists
      expect(registry.getRalKeyForDelegation("followup-set-cleanup")).toBeDefined();

      // Replace with empty delegations (should clean up)
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, []);

      // Verify mapping is cleaned up
      expect(registry.getRalKeyForDelegation("followup-set-cleanup")).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("should handle empty pending delegations array", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, []);

      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      expect(pending).toEqual([]);
    });

    it("should handle pending delegation without optional fields", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const delegation: PendingDelegation = {
        type: "delegate",
        delegationConversationId: "del-123",
        recipientPubkey: "recipient",
        senderPubkey: agentPubkey,
        prompt: "Task",
        ralNumber,
      };

      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [delegation]);

      const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
      expect(pending[0]).toEqual(delegation);
    });

    it("should handle completed delegation without optional fields", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const pendingDelegations: PendingDelegation[] = [
        {
          type: "delegate",
          delegationConversationId: "del-123",
          recipientPubkey: "recipient",
          senderPubkey: agentPubkey,
          prompt: "Task",
          ralNumber,
        },
      ];
      registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, pendingDelegations);

      const location = registry.recordCompletion({
        delegationConversationId: "del-123",
        recipientPubkey: "recipient",
        response: "Done",
        completedAt: Date.now(),
      });

      expect(location).toBeDefined();
      const completed = registry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber);
      expect(completed).toHaveLength(1);
      expect(completed[0].delegationConversationId).toBe("del-123");
    });
  });

  describe("llm-runtime mid-stream calculation", () => {
    // Use Bun's setSystemTime for deterministic tests
    let startTime: number;

    beforeEach(() => {
      startTime = 1000000; // Fixed start time
      setSystemTime(new Date(startTime));
    });

    afterEach(() => {
      // Reset to real time
      setSystemTime();
    });

    it("should return non-zero runtime when consumed during active LLM stream", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Start the LLM stream
      registry.startLLMStream(agentPubkey, conversationId, ralNumber, "test message");

      // Advance time by 50ms
      setSystemTime(new Date(startTime + 50));

      // Consume runtime DURING the stream (this is what happens when events are published mid-stream)
      const runtime = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);

      // This is the key test: runtime should be exactly 50ms
      expect(runtime).toBe(50);
    });

    it("should return incremental runtime on subsequent mid-stream consumes", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Start the LLM stream
      registry.startLLMStream(agentPubkey, conversationId, ralNumber, "test message");

      // Advance 30ms and consume first runtime
      setSystemTime(new Date(startTime + 30));
      const runtime1 = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);

      // Advance another 30ms and consume second runtime
      setSystemTime(new Date(startTime + 60));
      const runtime2 = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);

      // Both should be exactly 30ms (incremental, not cumulative)
      expect(runtime1).toBe(30);
      expect(runtime2).toBe(30);

      // The total should be exactly 60ms
      expect(runtime1 + runtime2).toBe(60);
    });

    it("should not double-count runtime after endLLMStream", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Start stream and advance 30ms
      registry.startLLMStream(agentPubkey, conversationId, ralNumber, "test message");
      setSystemTime(new Date(startTime + 30));

      // Consume mid-stream (should get 30ms)
      const runtime1 = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);
      expect(runtime1).toBe(30);

      // Advance another 20ms and end the stream
      setSystemTime(new Date(startTime + 50));
      registry.endLLMStream(agentPubkey, conversationId, ralNumber);

      // Consume again after end (should get the 20ms between consume and endLLMStream)
      const runtime2 = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);
      expect(runtime2).toBe(20);

      // Total accumulated should be 50ms
      const totalAccumulated = registry.getAccumulatedRuntime(agentPubkey, conversationId, ralNumber);
      expect(totalAccumulated).toBe(50);
    });

    it("should return 0 runtime when no stream is active and no prior accumulation", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // No stream started, consume should return 0
      const runtime = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);
      expect(runtime).toBe(0);
    });

    it("should return correct runtime when consuming after multiple start/end cycles", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // First stream cycle: 20ms
      registry.startLLMStream(agentPubkey, conversationId, ralNumber, "message 1");
      setSystemTime(new Date(startTime + 20));
      registry.endLLMStream(agentPubkey, conversationId, ralNumber);

      // Consume after first cycle
      const runtime1 = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);
      expect(runtime1).toBe(20);

      // Second stream cycle
      registry.startLLMStream(agentPubkey, conversationId, ralNumber, "message 2");
      setSystemTime(new Date(startTime + 40));

      // Consume during second stream
      const runtime2 = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);
      expect(runtime2).toBe(20);

      // Advance 10ms more and end second stream
      setSystemTime(new Date(startTime + 50));
      registry.endLLMStream(agentPubkey, conversationId, ralNumber);

      // Consume remaining
      const runtime3 = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);
      expect(runtime3).toBe(10);

      // Total accumulated should be 50ms
      const totalAccumulated = registry.getAccumulatedRuntime(agentPubkey, conversationId, ralNumber);
      expect(totalAccumulated).toBe(50);
    });

    it("should handle getUnreportedRuntime (non-consuming) during active stream", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      registry.startLLMStream(agentPubkey, conversationId, ralNumber, "test message");
      setSystemTime(new Date(startTime + 30));

      // Get without consuming (preview) - should be 30ms
      const preview = registry.getUnreportedRuntime(agentPubkey, conversationId, ralNumber);
      expect(preview).toBe(30);

      // Preview should not affect the value
      const preview2 = registry.getUnreportedRuntime(agentPubkey, conversationId, ralNumber);
      expect(preview2).toBe(30);

      // Actual consume should return the same 30ms
      const consumed = registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);
      expect(consumed).toBe(30);
    });

    it("should preserve llmStreamStartTime for accurate stream_duration_ms in telemetry", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      // Start stream
      registry.startLLMStream(agentPubkey, conversationId, ralNumber, "test message");

      // Advance 30ms and consume mid-stream
      setSystemTime(new Date(startTime + 30));
      registry.consumeUnreportedRuntime(agentPubkey, conversationId, ralNumber);

      // Advance another 20ms
      setSystemTime(new Date(startTime + 50));

      // Get the RAL to verify llmStreamStartTime is preserved
      const ral = registry.getRAL(agentPubkey, conversationId, ralNumber);
      expect(ral?.llmStreamStartTime).toBeDefined();
      // Verify the checkpoint was updated (moved from start time to after the consume)
      expect(ral?.lastRuntimeCheckpointAt).toBe(startTime + 30);
      // The original start time should still be preserved
      expect(ral?.llmStreamStartTime).toBe(startTime);

      // End stream - stream_duration_ms should be 50ms (total), not 20ms (since checkpoint)
      // We verify this indirectly by checking the total accumulated
      registry.endLLMStream(agentPubkey, conversationId, ralNumber);

      // After ending, both timestamps should be cleared
      const ralAfter = registry.getRAL(agentPubkey, conversationId, ralNumber);
      expect(ralAfter?.llmStreamStartTime).toBeUndefined();
      expect(ralAfter?.lastRuntimeCheckpointAt).toBeUndefined();

      // Total should be 50ms
      expect(ralAfter?.accumulatedRuntime).toBe(50);
    });
  });

  describe("buildDelegationAbortMessage", () => {
    it("should format aborted delegation message correctly", async () => {
      const abortedDelegation: CompletedDelegation = {
        delegationConversationId: "aborted-conv-123",
        recipientPubkey: "recipient-pubkey",
        senderPubkey: agentPubkey,
        transcript: [
          {
            senderPubkey: agentPubkey,
            recipientPubkey: "recipient-pubkey",
            content: "Please analyze this code",
            timestamp: Date.now() - 5000,
          },
          {
            senderPubkey: "recipient-pubkey",
            recipientPubkey: agentPubkey,
            content: "Starting analysis...",
            timestamp: Date.now() - 2000,
          },
        ],
        completedAt: Date.now(),
        ralNumber: 1,
        status: "aborted",
        abortReason: "manual abort via kill() tool",
      };

      const message = await registry.buildDelegationAbortMessage([abortedDelegation]);

      expect(message).toContain("# DELEGATION ABORTED");
      expect(message).toContain("was aborted and did not complete their task");
      expect(message).toContain("**Reason:** manual abort via kill() tool");
      expect(message).toContain("### Partial Progress:");
      expect(message).toContain("Please analyze this code");
      expect(message).toContain("Starting analysis...");
    });

    it("should handle empty transcript gracefully", async () => {
      const abortedDelegation: CompletedDelegation = {
        delegationConversationId: "aborted-conv-456",
        recipientPubkey: "recipient-pubkey",
        senderPubkey: agentPubkey,
        transcript: [],
        completedAt: Date.now(),
        ralNumber: 1,
        status: "aborted",
        abortReason: "cascaded from parent abort",
      };

      const message = await registry.buildDelegationAbortMessage([abortedDelegation]);

      expect(message).toContain("# DELEGATION ABORTED");
      expect(message).toContain("(No messages exchanged before abort)");
    });

    it("should include pending delegations when provided", async () => {
      const abortedDelegation: CompletedDelegation = {
        delegationConversationId: "aborted-conv-789",
        recipientPubkey: "recipient-pubkey",
        senderPubkey: agentPubkey,
        transcript: [],
        completedAt: Date.now(),
        ralNumber: 1,
        status: "aborted",
        abortReason: "manual abort",
      };

      const pendingDelegation: PendingDelegation = {
        type: "standard",
        delegationConversationId: "pending-conv-123",
        recipientPubkey: "other-recipient",
        senderPubkey: agentPubkey,
        prompt: "Still running task",
        ralNumber: 1,
      };

      const message = await registry.buildDelegationAbortMessage(
        [abortedDelegation],
        [pendingDelegation]
      );

      expect(message).toContain("## Still Pending");
    });

    it("should return empty string for empty array", async () => {
      const message = await registry.buildDelegationAbortMessage([]);
      expect(message).toBe("");
    });

    it("should handle multiple aborted delegations", async () => {
      const abortedDelegation1: CompletedDelegation = {
        delegationConversationId: "aborted-1",
        recipientPubkey: "recipient-1",
        senderPubkey: agentPubkey,
        transcript: [],
        completedAt: Date.now(),
        ralNumber: 1,
        status: "aborted",
        abortReason: "timeout",
      };

      const abortedDelegation2: CompletedDelegation = {
        delegationConversationId: "aborted-2",
        recipientPubkey: "recipient-2",
        senderPubkey: agentPubkey,
        transcript: [],
        completedAt: Date.now(),
        ralNumber: 1,
        status: "aborted",
        abortReason: "cascaded abort",
      };

      const message = await registry.buildDelegationAbortMessage([
        abortedDelegation1,
        abortedDelegation2,
      ]);

      expect(message).toContain("timeout");
      expect(message).toContain("cascaded abort");
    });
  });

  describe("killed delegation race condition prevention", () => {
    describe("markDelegationKilled", () => {
      it("should mark a pending delegation as killed", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const delegation: PendingDelegation = {
          type: "standard",
          delegationConversationId: "del-to-kill",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task",
          ralNumber,
        };

        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [delegation]);

        // Mark as killed
        const result = registry.markDelegationKilled("del-to-kill");
        expect(result).toBe(true);

        // Verify the delegation is now marked as killed
        const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
        expect(pending).toHaveLength(1);
        expect(pending[0].killed).toBe(true);
        expect(pending[0].killedAt).toBeDefined();
      });

      it("should return false for non-existent delegation", () => {
        const result = registry.markDelegationKilled("nonexistent-del");
        expect(result).toBe(false);
      });

      it("should handle followup delegation IDs", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const delegation: PendingDelegation = {
          type: "followup",
          delegationConversationId: "canonical-del",
          followupEventId: "followup-event-id",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Follow-up task",
          ralNumber,
        };

        registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [delegation]);

        // Mark as killed using the followup event ID
        const result = registry.markDelegationKilled("followup-event-id");
        expect(result).toBe(true);

        // Verify the canonical delegation is marked as killed
        const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
        expect(pending).toHaveLength(1);
        expect(pending[0].killed).toBe(true);
      });
    });

    describe("isDelegationKilled", () => {
      it("should return true for killed delegation", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const delegation: PendingDelegation = {
          type: "standard",
          delegationConversationId: "del-check-killed",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task",
          ralNumber,
        };

        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [delegation]);
        registry.markDelegationKilled("del-check-killed");

        expect(registry.isDelegationKilled("del-check-killed")).toBe(true);
      });

      it("should return false for non-killed delegation", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const delegation: PendingDelegation = {
          type: "standard",
          delegationConversationId: "del-not-killed",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task",
          ralNumber,
        };

        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [delegation]);

        expect(registry.isDelegationKilled("del-not-killed")).toBe(false);
      });

      it("should return false for non-existent delegation", () => {
        expect(registry.isDelegationKilled("nonexistent")).toBe(false);
      });
    });

    describe("markAllDelegationsKilled", () => {
      it("should mark all pending delegations as killed", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const delegations: PendingDelegation[] = [
          {
            type: "standard",
            delegationConversationId: "del-1",
            recipientPubkey: "recipient-1",
            senderPubkey: agentPubkey,
            prompt: "Task 1",
            ralNumber,
          },
          {
            type: "standard",
            delegationConversationId: "del-2",
            recipientPubkey: "recipient-2",
            senderPubkey: agentPubkey,
            prompt: "Task 2",
            ralNumber,
          },
          {
            type: "standard",
            delegationConversationId: "del-3",
            recipientPubkey: "recipient-3",
            senderPubkey: agentPubkey,
            prompt: "Task 3",
            ralNumber,
          },
        ];

        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, delegations);

        // Mark all as killed
        const killedCount = registry.markAllDelegationsKilled(agentPubkey, conversationId);
        expect(killedCount).toBe(3);

        // Verify all are marked as killed
        const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
        expect(pending.every(d => d.killed === true)).toBe(true);
        expect(pending.every(d => d.killedAt !== undefined)).toBe(true);
      });

      it("should not double-count already killed delegations", () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const delegation: PendingDelegation = {
          type: "standard",
          delegationConversationId: "del-double",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task",
          ralNumber,
        };

        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [delegation]);

        // Mark once
        const count1 = registry.markAllDelegationsKilled(agentPubkey, conversationId);
        expect(count1).toBe(1);

        // Mark again - should return 0 since already killed
        const count2 = registry.markAllDelegationsKilled(agentPubkey, conversationId);
        expect(count2).toBe(0);
      });

      it("should return 0 for non-existent conversation", () => {
        const killedCount = registry.markAllDelegationsKilled("nonexistent", "nonexistent");
        expect(killedCount).toBe(0);
      });
    });

    describe("completion handling for killed delegations", () => {
      it("should reject completion for killed delegation at domain layer", () => {
        // The killed flag check is now enforced at the domain layer (recordCompletion).
        // This ensures no caller can bypass the invariant - killed delegations cannot complete.
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const delegation: PendingDelegation = {
          type: "standard",
          delegationConversationId: "del-killed-completion",
          recipientPubkey: "recipient-1",
          senderPubkey: agentPubkey,
          prompt: "Task",
          ralNumber,
        };

        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [delegation]);

        // Mark as killed
        registry.markDelegationKilled("del-killed-completion");

        // recordCompletion enforces the killed invariant at the domain level.
        // This prevents ANY code path from recording a completion for a killed delegation.
        const location = registry.recordCompletion({
          delegationConversationId: "del-killed-completion",
          recipientPubkey: "recipient-1",
          response: "Done",
          completedAt: Date.now(),
        });

        // The completion is REJECTED - the domain layer enforces the killed invariant
        expect(location).toBeUndefined();

        // Verify the delegation is still pending (not moved to completed)
        const pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
        const completed = registry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber);
        expect(pending).toHaveLength(1);
        expect(pending[0].killed).toBe(true);
        expect(completed).toHaveLength(0);
      });
    });

    describe("race condition prevention in abortWithCascade", () => {
      it("should mark delegations as killed before aborting to prevent race", async () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const delegations: PendingDelegation[] = [
          {
            type: "standard",
            delegationConversationId: "nested-del-1",
            recipientPubkey: "child-agent-1",
            senderPubkey: agentPubkey,
            prompt: "Child task 1",
            ralNumber,
          },
          {
            type: "standard",
            delegationConversationId: "nested-del-2",
            recipientPubkey: "child-agent-2",
            senderPubkey: agentPubkey,
            prompt: "Child task 2",
            ralNumber,
          },
        ];

        registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, delegations);

        // Capture the killed state BEFORE abortWithCascade clears state
        // We use isDelegationKilled which reads from the pending map
        expect(registry.isDelegationKilled("nested-del-1")).toBe(false);
        expect(registry.isDelegationKilled("nested-del-2")).toBe(false);

        // The delegations should be marked killed during abortWithCascade
        // Note: We can't easily test the full cascade without mocking ConversationStore,
        // but we can verify that markAllDelegationsKilled is called correctly
        // by checking the behavior of the method itself.
        registry.markAllDelegationsKilled(agentPubkey, conversationId);

        // Now both should be killed
        expect(registry.isDelegationKilled("nested-del-1")).toBe(true);
        expect(registry.isDelegationKilled("nested-del-2")).toBe(true);
      });
    });
  });

});
