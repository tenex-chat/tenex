import { beforeEach, describe, expect, it } from "bun:test";
import { RALRegistry } from "../RALRegistry";
import type { CoreMessage } from "ai";
import type { PendingDelegation, CompletedDelegation } from "../types";
import { NDKEvent } from "@nostr-dev-kit/ndk";

describe("RALRegistry", () => {
  let registry: RALRegistry;
  const agentPubkey = "agent-pubkey-123";
  const agentPubkey2 = "agent-pubkey-456";

  beforeEach(() => {
    registry = RALRegistry.getInstance();
    // Clear any existing state
    registry.clear(agentPubkey);
    registry.clear(agentPubkey2);
  });

  describe("singleton pattern", () => {
    it("should return same instance", () => {
      const instance1 = RALRegistry.getInstance();
      const instance2 = RALRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("create", () => {
    it("should create a new RAL entry", () => {
      const ralId = registry.create(agentPubkey);
      expect(ralId).toBeDefined();
      expect(typeof ralId).toBe("string");
      expect(ralId.length).toBeGreaterThan(0);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state).toBeDefined();
      expect(state?.id).toBe(ralId);
      expect(state?.agentPubkey).toBe(agentPubkey);
      expect(state?.status).toBe("executing");
      expect(state?.messages).toEqual([]);
      expect(state?.pendingDelegations).toEqual([]);
      expect(state?.completedDelegations).toEqual([]);
      expect(state?.queuedInjections).toEqual([]);
      expect(state?.createdAt).toBeDefined();
      expect(state?.lastActivityAt).toBeDefined();
    });

    it("should create unique RAL IDs", () => {
      const ralId1 = registry.create(agentPubkey);
      registry.clear(agentPubkey);
      const ralId2 = registry.create(agentPubkey);
      expect(ralId1).not.toBe(ralId2);
    });

    it("should overwrite existing state for same agent", () => {
      const ralId1 = registry.create(agentPubkey);
      const ralId2 = registry.create(agentPubkey);
      expect(ralId1).not.toBe(ralId2);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.id).toBe(ralId2);
    });
  });

  describe("getStateByAgent", () => {
    it("should return undefined for non-existent agent", () => {
      const state = registry.getStateByAgent("nonexistent");
      expect(state).toBeUndefined();
    });

    it("should return state for existing agent", () => {
      const ralId = registry.create(agentPubkey);
      const state = registry.getStateByAgent(agentPubkey);
      expect(state).toBeDefined();
      expect(state?.id).toBe(ralId);
    });
  });

  describe("setStatus", () => {
    it("should update status", () => {
      registry.create(agentPubkey);
      const initialState = registry.getStateByAgent(agentPubkey);
      const initialLastActivity = initialState?.lastActivityAt;

      registry.setStatus(agentPubkey, "paused");

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.status).toBe("paused");
      expect(state?.lastActivityAt).toBeGreaterThanOrEqual(initialLastActivity!);
    });

    it("should handle status update for non-existent agent gracefully", () => {
      expect(() => {
        registry.setStatus("nonexistent", "paused");
      }).not.toThrow();
    });

    it("should update lastActivityAt when status changes", () => {
      registry.create(agentPubkey);
      const initialState = registry.getStateByAgent(agentPubkey);
      const initialTime = initialState?.lastActivityAt;

      // Wait a bit to ensure timestamp difference
      const start = Date.now();
      while (Date.now() - start < 2) {
        // Small delay
      }

      registry.setStatus(agentPubkey, "done");
      const updatedState = registry.getStateByAgent(agentPubkey);

      expect(updatedState?.lastActivityAt).toBeGreaterThan(initialTime!);
    });
  });

  describe("saveState", () => {
    it("should save messages and pending delegations", () => {
      registry.create(agentPubkey);

      const messages: CoreMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];

      const pendingDelegations: PendingDelegation[] = [
        {
          eventId: "del-event-1",
          recipientPubkey: "recipient-1",
          prompt: "Do task 1",
        },
        {
          eventId: "del-event-2",
          recipientPubkey: "recipient-2",
          recipientSlug: "agent-2",
          prompt: "Do task 2",
          isFollowup: true,
        },
      ];

      registry.saveState(agentPubkey, messages, pendingDelegations);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.messages).toEqual(messages);
      expect(state?.pendingDelegations).toEqual(pendingDelegations);
      expect(state?.status).toBe("paused");
    });

    it("should create delegation event ID to RAL ID mappings", () => {
      const ralId = registry.create(agentPubkey);

      const pendingDelegations: PendingDelegation[] = [
        {
          eventId: "del-event-1",
          recipientPubkey: "recipient-1",
          prompt: "Task 1",
        },
        {
          eventId: "del-event-2",
          recipientPubkey: "recipient-2",
          prompt: "Task 2",
        },
      ];

      registry.saveState(agentPubkey, [], pendingDelegations);

      expect(registry.getRalIdForDelegation("del-event-1")).toBe(ralId);
      expect(registry.getRalIdForDelegation("del-event-2")).toBe(ralId);
    });

    it("should handle saveState for non-existent agent gracefully", () => {
      const messages: CoreMessage[] = [{ role: "user", content: "Test" }];
      const delegations: PendingDelegation[] = [];

      expect(() => {
        registry.saveState("nonexistent", messages, delegations);
      }).not.toThrow();
    });

    it("should update lastActivityAt when saving state", () => {
      registry.create(agentPubkey);
      const initialState = registry.getStateByAgent(agentPubkey);
      const initialTime = initialState?.lastActivityAt;

      // Small delay
      const start = Date.now();
      while (Date.now() - start < 2) {}

      registry.saveState(agentPubkey, [], []);
      const updatedState = registry.getStateByAgent(agentPubkey);

      expect(updatedState?.lastActivityAt).toBeGreaterThan(initialTime!);
    });
  });

  describe("getRalIdForDelegation", () => {
    it("should return undefined for non-existent delegation", () => {
      const ralId = registry.getRalIdForDelegation("nonexistent");
      expect(ralId).toBeUndefined();
    });

    it("should return RAL ID for registered delegation", () => {
      const ralId = registry.create(agentPubkey);
      const delegations: PendingDelegation[] = [
        {
          eventId: "del-123",
          recipientPubkey: "recipient",
          prompt: "Task",
        },
      ];

      registry.saveState(agentPubkey, [], delegations);

      expect(registry.getRalIdForDelegation("del-123")).toBe(ralId);
    });
  });

  describe("recordCompletion", () => {
    it("should record a delegation completion", () => {
      registry.create(agentPubkey);

      const pendingDelegations: PendingDelegation[] = [
        {
          eventId: "del-event-1",
          recipientPubkey: "recipient-1",
          prompt: "Task 1",
        },
        {
          eventId: "del-event-2",
          recipientPubkey: "recipient-2",
          prompt: "Task 2",
        },
      ];

      registry.saveState(agentPubkey, [], pendingDelegations);

      const completion: CompletedDelegation = {
        eventId: "del-event-1",
        recipientPubkey: "recipient-1",
        response: "Task completed",
        responseEventId: "response-123",
        completedAt: Date.now(),
      };

      registry.recordCompletion(agentPubkey, completion);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.completedDelegations).toHaveLength(1);
      expect(state?.completedDelegations[0]).toEqual(completion);
      expect(state?.pendingDelegations).toHaveLength(1);
      expect(state?.pendingDelegations[0].eventId).toBe("del-event-2");
    });

    it("should handle completion for non-existent agent gracefully", () => {
      const completion: CompletedDelegation = {
        eventId: "del-event-1",
        recipientPubkey: "recipient-1",
        response: "Done",
        completedAt: Date.now(),
      };

      expect(() => {
        registry.recordCompletion("nonexistent", completion);
      }).not.toThrow();
    });

    it("should update lastActivityAt when recording completion", () => {
      registry.create(agentPubkey);
      const initialState = registry.getStateByAgent(agentPubkey);
      const initialTime = initialState?.lastActivityAt;

      const start = Date.now();
      while (Date.now() - start < 2) {}

      const completion: CompletedDelegation = {
        eventId: "del-123",
        recipientPubkey: "recipient",
        response: "Done",
        completedAt: Date.now(),
      };

      registry.recordCompletion(agentPubkey, completion);
      const updatedState = registry.getStateByAgent(agentPubkey);

      expect(updatedState?.lastActivityAt).toBeGreaterThan(initialTime!);
    });
  });

  describe("queueEvent", () => {
    it("should queue an event for injection", () => {
      registry.create(agentPubkey);

      const event = new NDKEvent();
      event.content = "Test event content";
      event.id = "event-123";

      registry.queueEvent(agentPubkey, event);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.queuedInjections).toHaveLength(1);
      expect(state?.queuedInjections[0].type).toBe("user");
      expect(state?.queuedInjections[0].content).toBe("Test event content");
      expect(state?.queuedInjections[0].eventId).toBe("event-123");
      expect(state?.queuedInjections[0].queuedAt).toBeDefined();
    });

    it("should handle queueEvent for non-existent agent gracefully", () => {
      const event = new NDKEvent();
      event.content = "Test";
      event.id = "event-123";

      expect(() => {
        registry.queueEvent("nonexistent", event);
      }).not.toThrow();
    });

    it("should queue multiple events", () => {
      registry.create(agentPubkey);

      const event1 = new NDKEvent();
      event1.content = "Event 1";
      event1.id = "event-1";

      const event2 = new NDKEvent();
      event2.content = "Event 2";
      event2.id = "event-2";

      registry.queueEvent(agentPubkey, event1);
      registry.queueEvent(agentPubkey, event2);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.queuedInjections).toHaveLength(2);
      expect(state?.queuedInjections[0].eventId).toBe("event-1");
      expect(state?.queuedInjections[1].eventId).toBe("event-2");
    });
  });

  describe("queueSystemMessage", () => {
    it("should queue a system message", () => {
      registry.create(agentPubkey);

      registry.queueSystemMessage(agentPubkey, "System message content");

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.queuedInjections).toHaveLength(1);
      expect(state?.queuedInjections[0].type).toBe("system");
      expect(state?.queuedInjections[0].content).toBe("System message content");
      expect(state?.queuedInjections[0].eventId).toBeUndefined();
      expect(state?.queuedInjections[0].queuedAt).toBeDefined();
    });

    it("should handle queueSystemMessage for non-existent agent gracefully", () => {
      expect(() => {
        registry.queueSystemMessage("nonexistent", "Test");
      }).not.toThrow();
    });
  });

  describe("eventStillQueued", () => {
    it("should return false for non-existent agent", () => {
      expect(registry.eventStillQueued("nonexistent", "event-123")).toBe(false);
    });

    it("should return false when event is not queued", () => {
      registry.create(agentPubkey);
      expect(registry.eventStillQueued(agentPubkey, "event-123")).toBe(false);
    });

    it("should return true when event is queued", () => {
      registry.create(agentPubkey);

      const event = new NDKEvent();
      event.content = "Test";
      event.id = "event-123";

      registry.queueEvent(agentPubkey, event);

      expect(registry.eventStillQueued(agentPubkey, "event-123")).toBe(true);
    });

    it("should return false after event is cleared", () => {
      registry.create(agentPubkey);

      const event = new NDKEvent();
      event.content = "Test";
      event.id = "event-123";

      registry.queueEvent(agentPubkey, event);
      expect(registry.eventStillQueued(agentPubkey, "event-123")).toBe(true);

      registry.getAndClearQueued(agentPubkey);
      expect(registry.eventStillQueued(agentPubkey, "event-123")).toBe(false);
    });
  });

  describe("getAndClearQueued", () => {
    it("should return empty array for non-existent agent", () => {
      const injections = registry.getAndClearQueued("nonexistent");
      expect(injections).toEqual([]);
    });

    it("should return and clear queued injections", () => {
      registry.create(agentPubkey);

      const event = new NDKEvent();
      event.content = "User event";
      event.id = "event-123";

      registry.queueEvent(agentPubkey, event);
      registry.queueSystemMessage(agentPubkey, "System message");

      const injections = registry.getAndClearQueued(agentPubkey);

      expect(injections).toHaveLength(2);
      expect(injections[0].type).toBe("user");
      expect(injections[0].content).toBe("User event");
      expect(injections[1].type).toBe("system");
      expect(injections[1].content).toBe("System message");

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.queuedInjections).toEqual([]);
    });

    it("should return copy of injections, not original array", () => {
      registry.create(agentPubkey);

      registry.queueSystemMessage(agentPubkey, "Test");

      const injections1 = registry.getAndClearQueued(agentPubkey);
      const injections2 = registry.getAndClearQueued(agentPubkey);

      expect(injections1).toHaveLength(1);
      expect(injections2).toEqual([]);
    });
  });

  describe("swapQueuedEvent", () => {
    it("should swap user event with system message", () => {
      registry.create(agentPubkey);

      const event = new NDKEvent();
      event.content = "User event";
      event.id = "event-123";

      registry.queueEvent(agentPubkey, event);

      registry.swapQueuedEvent(agentPubkey, "event-123", "System message instead");

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.queuedInjections).toHaveLength(1);
      expect(state?.queuedInjections[0].type).toBe("system");
      expect(state?.queuedInjections[0].content).toBe("System message instead");
      expect(state?.queuedInjections[0].eventId).toBeUndefined();
    });

    it("should handle swapQueuedEvent for non-existent agent gracefully", () => {
      expect(() => {
        registry.swapQueuedEvent("nonexistent", "event-123", "System message");
      }).not.toThrow();
    });

    it("should only remove the specific event", () => {
      registry.create(agentPubkey);

      const event1 = new NDKEvent();
      event1.content = "Event 1";
      event1.id = "event-1";

      const event2 = new NDKEvent();
      event2.content = "Event 2";
      event2.id = "event-2";

      registry.queueEvent(agentPubkey, event1);
      registry.queueEvent(agentPubkey, event2);

      registry.swapQueuedEvent(agentPubkey, "event-1", "System replacement");

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.queuedInjections).toHaveLength(2);
      expect(state?.queuedInjections.some((i) => i.eventId === "event-2")).toBe(true);
      expect(state?.queuedInjections.some((i) => i.type === "system")).toBe(true);
    });
  });

  describe("setCurrentTool", () => {
    it("should set current tool and toolStartedAt", () => {
      registry.create(agentPubkey);

      registry.setCurrentTool(agentPubkey, "read_path");

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.currentTool).toBe("read_path");
      expect(state?.toolStartedAt).toBeDefined();
    });

    it("should clear current tool when set to undefined", () => {
      registry.create(agentPubkey);

      registry.setCurrentTool(agentPubkey, "read_path");
      registry.setCurrentTool(agentPubkey, undefined);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.currentTool).toBeUndefined();
      expect(state?.toolStartedAt).toBeUndefined();
    });

    it("should handle setCurrentTool for non-existent agent gracefully", () => {
      expect(() => {
        registry.setCurrentTool("nonexistent", "read_path");
      }).not.toThrow();
    });
  });

  describe("abort controller management", () => {
    it("should register and abort controller", () => {
      registry.create(agentPubkey);

      const controller = new AbortController();
      registry.registerAbortController(agentPubkey, controller);

      expect(controller.signal.aborted).toBe(false);

      registry.abortCurrentTool(agentPubkey);

      expect(controller.signal.aborted).toBe(true);
    });

    it("should handle abort without registered controller gracefully", () => {
      registry.create(agentPubkey);

      expect(() => {
        registry.abortCurrentTool(agentPubkey);
      }).not.toThrow();
    });

    it("should clear controller after abort", () => {
      registry.create(agentPubkey);

      const controller = new AbortController();
      registry.registerAbortController(agentPubkey, controller);
      registry.abortCurrentTool(agentPubkey);

      // Aborting again should not affect the already aborted controller
      expect(() => {
        registry.abortCurrentTool(agentPubkey);
      }).not.toThrow();
    });
  });

  describe("clear", () => {
    it("should clear RAL state", () => {
      registry.create(agentPubkey);

      const event = new NDKEvent();
      event.content = "Test";
      event.id = "event-123";
      registry.queueEvent(agentPubkey, event);

      registry.clear(agentPubkey);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state).toBeUndefined();
    });

    it("should clean up delegation mappings", () => {
      const ralId = registry.create(agentPubkey);

      const pendingDelegations: PendingDelegation[] = [
        {
          eventId: "del-pending-1",
          recipientPubkey: "recipient-1",
          prompt: "Task 1",
        },
      ];

      registry.saveState(agentPubkey, [], pendingDelegations);

      const completion: CompletedDelegation = {
        eventId: "del-completed-1",
        recipientPubkey: "recipient-2",
        response: "Done",
        completedAt: Date.now(),
      };

      registry.recordCompletion(agentPubkey, completion);

      expect(registry.getRalIdForDelegation("del-pending-1")).toBe(ralId);

      registry.clear(agentPubkey);

      expect(registry.getRalIdForDelegation("del-pending-1")).toBeUndefined();
      expect(registry.getRalIdForDelegation("del-completed-1")).toBeUndefined();
    });

    it("should clear abort controllers", () => {
      registry.create(agentPubkey);

      const controller = new AbortController();
      registry.registerAbortController(agentPubkey, controller);

      registry.clear(agentPubkey);

      // Should not be able to abort after clear
      expect(() => {
        registry.abortCurrentTool(agentPubkey);
      }).not.toThrow();
    });

    it("should handle clear for non-existent agent gracefully", () => {
      expect(() => {
        registry.clear("nonexistent");
      }).not.toThrow();
    });
  });

  describe("getStateSummary", () => {
    it("should return 'No active execution' for non-existent agent", () => {
      const summary = registry.getStateSummary("nonexistent");
      expect(summary).toBe("No active execution");
    });

    it("should return summary when between tool calls", () => {
      registry.create(agentPubkey);

      const messages: CoreMessage[] = [
        { role: "user", content: "What is the weather?" },
        { role: "assistant", content: "Let me check that for you." },
      ];

      registry.saveState(agentPubkey, messages, []);

      const summary = registry.getStateSummary(agentPubkey);
      expect(summary).toContain("Between tool calls");
      expect(summary).toContain("user:");
      expect(summary).toContain("assistant:");
    });

    it("should return summary when running a tool", () => {
      registry.create(agentPubkey);

      registry.setCurrentTool(agentPubkey, "read_path");

      const summary = registry.getStateSummary(agentPubkey);
      expect(summary).toContain("Running tool: read_path");
    });

    it("should include recent messages in summary", () => {
      registry.create(agentPubkey);

      const messages: CoreMessage[] = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Message 2" },
        { role: "user", content: "Message 3" },
        { role: "assistant", content: "Message 4" },
        { role: "user", content: "Message 5" },
      ];

      registry.saveState(agentPubkey, messages, []);

      const summary = registry.getStateSummary(agentPubkey);
      // Should include last 4 messages
      expect(summary).not.toContain("Message 1");
      expect(summary).toContain("Message 2");
      expect(summary).toContain("Message 5");
    });

    it("should truncate long message content", () => {
      registry.create(agentPubkey);

      const longContent = "a".repeat(200);
      const messages: CoreMessage[] = [{ role: "user", content: longContent }];

      registry.saveState(agentPubkey, messages, []);

      const summary = registry.getStateSummary(agentPubkey);
      expect(summary.length).toBeLessThan(longContent.length + 100);
      expect(summary).toContain("...");
    });
  });

  describe("multiple agents", () => {
    it("should handle multiple agents independently", () => {
      const ralId1 = registry.create(agentPubkey);
      const ralId2 = registry.create(agentPubkey2);

      expect(ralId1).not.toBe(ralId2);

      const event1 = new NDKEvent();
      event1.content = "Event for agent 1";
      event1.id = "event-1";

      const event2 = new NDKEvent();
      event2.content = "Event for agent 2";
      event2.id = "event-2";

      registry.queueEvent(agentPubkey, event1);
      registry.queueEvent(agentPubkey2, event2);

      const state1 = registry.getStateByAgent(agentPubkey);
      const state2 = registry.getStateByAgent(agentPubkey2);

      expect(state1?.queuedInjections).toHaveLength(1);
      expect(state1?.queuedInjections[0].eventId).toBe("event-1");

      expect(state2?.queuedInjections).toHaveLength(1);
      expect(state2?.queuedInjections[0].eventId).toBe("event-2");
    });

    it("should clear one agent without affecting others", () => {
      registry.create(agentPubkey);
      registry.create(agentPubkey2);

      registry.queueSystemMessage(agentPubkey, "Message 1");
      registry.queueSystemMessage(agentPubkey2, "Message 2");

      registry.clear(agentPubkey);

      expect(registry.getStateByAgent(agentPubkey)).toBeUndefined();
      expect(registry.getStateByAgent(agentPubkey2)).toBeDefined();

      const state2 = registry.getStateByAgent(agentPubkey2);
      expect(state2?.queuedInjections).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("should handle empty message arrays", () => {
      registry.create(agentPubkey);
      registry.saveState(agentPubkey, [], []);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.messages).toEqual([]);
    });

    it("should handle messages with complex content", () => {
      registry.create(agentPubkey);

      const messages: CoreMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
      ];

      registry.saveState(agentPubkey, messages, []);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.messages).toEqual(messages);
    });

    it("should handle pending delegation without optional fields", () => {
      registry.create(agentPubkey);

      const delegation: PendingDelegation = {
        eventId: "del-123",
        recipientPubkey: "recipient",
        prompt: "Task",
      };

      registry.saveState(agentPubkey, [], [delegation]);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.pendingDelegations[0]).toEqual(delegation);
    });

    it("should handle completed delegation without optional fields", () => {
      registry.create(agentPubkey);

      const completion: CompletedDelegation = {
        eventId: "del-123",
        recipientPubkey: "recipient",
        response: "Done",
        completedAt: Date.now(),
      };

      registry.recordCompletion(agentPubkey, completion);

      const state = registry.getStateByAgent(agentPubkey);
      expect(state?.completedDelegations[0]).toEqual(completion);
    });
  });
});
