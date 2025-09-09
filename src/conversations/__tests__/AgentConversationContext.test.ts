import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Conversation, AgentState } from "../types";

// Mock the modules before importing them
mock.module("@/services", () => ({
  getProjectContext: mock(() => {
    const agents = new Map();
    agents.set("test-agent", { name: "Test Agent", pubkey: "agent-pubkey", slug: "test-agent" });
    agents.set("other-agent", { name: "Other Agent", pubkey: "other-agent-pubkey", slug: "other-agent" });
    return {
      agents,
      getAgent: mock((slug: string) => agents.get(slug)),
      getAgentByPubkey: mock((pubkey: string) => {
        if (pubkey === "agent-pubkey") return agents.get("test-agent");
        if (pubkey === "other-agent-pubkey") return agents.get("other-agent");
        if (pubkey === "agent1-pubkey") return { name: "Agent 1", pubkey: "agent1-pubkey" };
        if (pubkey === "agent2-pubkey") return { name: "Agent 2", pubkey: "agent2-pubkey" };
        return null;
      })
    };
  }),
  isProjectContextInitialized: mock(() => true)
}));

mock.module("@/services/PubkeyNameRepository", () => ({
  getPubkeyNameRepository: mock(() => ({
    getName: mock(async () => "TestUser"),
    getNameSync: mock(() => "TestUser")
  }))
}));

mock.module("@/services/DelegationRegistry", () => ({
  DelegationRegistry: {
    getInstance: mock(() => ({
      getDelegationContext: mock(() => null)
    }))
  }
}));

mock.module("@/nostr", () => ({
  getNDK: mock(() => ({
    fetchEvent: mock(() => null)
  }))
}));

mock.module("@/nostr/utils", () => ({
  getAgentSlugFromEvent: mock((event: any) => {
    // Return agent slug if event is from an agent
    if (event?.pubkey === "agent-pubkey") return "test-agent";
    if (event?.pubkey === "other-agent-pubkey") return "other-agent";
    return null;
  }),
  getTargetedAgentSlugsFromEvent: mock(() => []),
  isEventFromUser: mock((event: any) => {
    // Return true only for user events
    return event?.pubkey === "user-pubkey";
  })
}));

mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {})
  }
}));

// Now import after mocking
import { createMockNDKEvent } from "@/test-utils/bun-mocks";
import { AgentConversationContext } from "../AgentConversationContext";

describe("AgentConversationContext", () => {
  let context: AgentConversationContext;
  let mockConversation: Conversation;
  let mockAgentState: AgentState;

  beforeEach(() => {
    context = new AgentConversationContext("test-conversation", "test-agent");
    
    // Create mock conversation
    mockConversation = {
      id: "test-conversation",
      title: "Test Conversation",
      phase: "CHAT",
      history: [],
      agentStates: new Map(),
      phaseStartedAt: Date.now(),
      metadata: {},
      executionTime: {
        totalSeconds: 0,
        isActive: false,
        lastUpdated: Date.now()
      }
    };

    // Create mock agent state
    mockAgentState = {
      lastProcessedMessageIndex: 0,
      lastSeenPhase: undefined
    };
  });

  describe("stateless message building", () => {
    it("should build messages from conversation history", async () => {
      const event1 = createMockNDKEvent();
      event1.id = "event-1";
      event1.content = "First message";
      event1.pubkey = "user-pubkey";
      event1.created_at = Date.now() / 1000;

      const event2 = createMockNDKEvent();
      event2.id = "event-2";
      event2.content = "Second message";
      event2.pubkey = "other-agent-pubkey";
      event2.created_at = Date.now() / 1000;

      // Add events to conversation history
      mockConversation.history = [event1, event2];

      // Build messages
      const messages = await context.buildMessages(
        mockConversation,
        mockAgentState
      );

      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("system"); // Other agent's message
    });

    it("should not include triggering event in history", async () => {
      const event1 = createMockNDKEvent();
      event1.id = "event-1";
      event1.content = "First message";
      event1.pubkey = "user-pubkey";

      const event2 = createMockNDKEvent();
      event2.id = "event-2";
      event2.content = "Second message";
      event2.pubkey = "user-pubkey";

      const triggeringEvent = createMockNDKEvent();
      triggeringEvent.id = "event-3";
      triggeringEvent.content = "Triggering message";
      triggeringEvent.pubkey = "user-pubkey";

      // Add all events to conversation history
      mockConversation.history = [event1, event2, triggeringEvent];

      // Build messages with triggering event
      const messages = await context.buildMessages(
        mockConversation,
        mockAgentState,
        triggeringEvent
      );

      // Should have 3 messages: 2 from history + 1 triggering event
      expect(messages.length).toBe(3);
      // Last message should be the triggering event
      expect(messages[2].content).toContain("Triggering message");
    });

    it("should add phase transition message when needed", async () => {
      const event1 = createMockNDKEvent();
      event1.id = "event-1";
      event1.content = "Test message";
      event1.pubkey = "user-pubkey";

      mockConversation.history = [event1];
      mockConversation.phase = "REFLECTION";
      mockAgentState.lastSeenPhase = "CHAT";

      const phaseInstructions = "You are now in reflection phase";

      // Build messages with phase instructions
      const messages = await context.buildMessages(
        mockConversation,
        mockAgentState,
        undefined,
        phaseInstructions
      );

      // Should have history message + phase transition message
      expect(messages.length).toBe(2);
      expect(messages[1].role).toBe("system");
      expect(messages[1].content).toContain("PHASE TRANSITION");
      expect(messages[1].content).toContain(phaseInstructions);
    });

    it("should build messages with missed history", async () => {
      const missedEvent1 = createMockNDKEvent();
      missedEvent1.id = "missed-1";
      missedEvent1.content = "Missed message 1";
      missedEvent1.pubkey = "user-pubkey";

      const missedEvent2 = createMockNDKEvent();
      missedEvent2.id = "missed-2";
      missedEvent2.content = "Missed message 2";
      missedEvent2.pubkey = "agent-pubkey";

      const triggeringEvent = createMockNDKEvent();
      triggeringEvent.id = "trigger";
      triggeringEvent.content = "New message";
      triggeringEvent.pubkey = "user-pubkey";

      // Build messages with missed history
      const messages = await context.buildMessagesWithMissedHistory(
        mockConversation,
        mockAgentState,
        [missedEvent1, missedEvent2],
        "Previous delegation summary",
        triggeringEvent
      );

      // Should have: missed messages block + triggering event
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("MESSAGES WHILE YOU WERE AWAY");
      expect(messages[0].content).toContain("Previous delegation summary");
      expect(messages[1].role).toBe("user");
      expect(messages[1].content).toContain("New message");
    });

    it("should extract session ID from event", () => {
      const event = createMockNDKEvent();
      event.id = "event-123";
      event.content = "Test message";
      
      // Mock the tagValue method to return a session ID
      event.tagValue = mock((tag: string) => {
        if (tag === "claude-session") {
          return "session-123";
        }
        return undefined;
      });

      const sessionId = context.extractSessionId(event);
      expect(sessionId).toBe("session-123");
    });

    it("should build messages with delegation responses", () => {
      const responses = new Map();
      const response1 = createMockNDKEvent();
      response1.content = "Response from agent 1";
      response1.pubkey = "agent1-pubkey";
      responses.set("agent1-pubkey", response1);

      const response2 = createMockNDKEvent();
      response2.content = "Response from agent 2";
      response2.pubkey = "agent2-pubkey";
      responses.set("agent2-pubkey", response2);

      const messages = context.buildMessagesWithDelegationResponses(
        responses,
        "Original delegation request",
        mockConversation,
        mockAgentState
      );

      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("DELEGATE RESPONSES RECEIVED");
      expect(messages[0].content).toContain("Original delegation request");
      expect(messages[0].content).toContain("Response from agent 1");
      expect(messages[0].content).toContain("Response from agent 2");
    });
  });
});