import type { AgentInstance } from "@/agents/types";
import { EVENT_KINDS } from "@/llm/types";
import { NDKEvent, NDKKind, type NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import { AgentEventDecoder } from "../AgentEventDecoder";
import {
  AgentEventEncoder,
  type CompletionIntent,
  type ConversationIntent,
  type DelegationIntent,
  type EventContext,
} from "../AgentEventEncoder";
import { 
  TENEXTestFixture, 
  getTestUserWithSigner,
  createMockAgentConfig,
  type TestUserName 
} from "@/test-utils/ndk-test-helpers";
import { createMockNDKEvent } from "@/test-utils/bun-mocks"; // Keep for AgentEventDecoder tests

// Mock the modules
mock.module("@/nostr/ndkClient", () => ({
  getNDK: mock(() => ({
    // Mock NDK instance
  })),
}));

mock.module("@/services", () => ({
  getProjectContext: mock(),
}));

import { getProjectContext } from "@/services";
import { getNDK } from "@/nostr/ndkClient";

describe("AgentEventEncoder", () => {
  let encoder: AgentEventEncoder;
  let mockConversationCoordinator: any;

  beforeEach(() => {
    // Setup default mock for getProjectContext
    const defaultProjectContext = {
      project: {
        pubkey: "defaultOwner",
        tagReference: () => ["a", "31933:defaultOwner:default-project"],
      },
    };
    (getProjectContext as ReturnType<typeof mock>).mockReturnValue(defaultProjectContext);

    // Create mock ConversationCoordinator
    mockConversationCoordinator = {
      getConversation: mock(() => ({
        history: [mockConversationEvent, mockTriggeringEvent]
      }))
    };

    // Create AgentEventEncoder instance
    encoder = new AgentEventEncoder(mockConversationCoordinator);
  });
  
  const mockAgent: AgentInstance = {
    name: "TestAgent",
    pubkey: "agent123",
    slug: "test-agent",
    signer: {} as NDKPrivateKeySigner,
    llmConfig: "test-config",
    tools: [],
    role: "test",
  };

  const mockTriggeringEvent = createMockNDKEvent();
  mockTriggeringEvent.id = "trigger123";
  mockTriggeringEvent.tags = [
    ["e", "root123", "", "root"],
    ["e", "reply123", "", "reply"],
  ];

  const mockConversationEvent = createMockNDKEvent();
  mockConversationEvent.id = "conv123";
  mockConversationEvent.content = "Initial conversation";
  mockConversationEvent.kind = NDKKind.Text;
  mockConversationEvent.pubkey = "user123";

  const baseContext: EventContext = {
    triggeringEvent: mockTriggeringEvent,
    rootEvent: mockConversationEvent,
    conversationId: "conv123",
  };

  describe("encodeCompletion", () => {
    it("should encode a basic completion intent", () => {
      const intent: CompletionIntent = {
        
        content: "Task completed successfully",
      };

      const event = encoder.encodeCompletion(intent, baseContext);

      expect(event.kind).toBe(NDKKind.GenericReply);
      expect(event.content).toBe("Task completed successfully");

      // Check conversation tags are added
      const eTags = event.getMatchingTags("e");
      expect(eTags).toHaveLength(1);
      expect(eTags[0]).toEqual(["e", "trigger123", "", "reply"]); // References the triggering event
    });

    it("should include optional completion metadata", () => {
      const intent: CompletionIntent = {
        
        content: "Analysis complete",
        summary: "Found 3 issues",
      };

      const event = encoder.encodeCompletion(intent, baseContext);

      expect(event.tagValue("summary")).toBe("Found 3 issues");
    });

    it("should include execution metadata when provided", () => {
      const contextWithMetadata: EventContext = {
        ...baseContext,
        model: "gpt-4",
        executionTime: 1500,
      };

      const intent: CompletionIntent = {
        
        content: "Done",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      };

      const event = encoder.encodeCompletion(intent, contextWithMetadata);

      expect(event.tagValue("llm-model")).toBe("gpt-4");
      expect(event.tagValue("execution-time")).toBe("1500");
      expect(event.tagValue("llm-prompt-tokens")).toBe("100");
      expect(event.tagValue("llm-completion-tokens")).toBe("50");
      expect(event.tagValue("llm-total-tokens")).toBe("150");
    });


    it("should include phase information when provided", () => {
      const contextWithPhase: EventContext = {
        ...baseContext,
        phase: "implementation",
      };

      const intent: CompletionIntent = {
        
        content: "Implementation completed",
      };

      const event = encoder.encodeCompletion(intent, contextWithPhase);

      expect(event.tagValue("phase")).toBe("implementation");
    });
  });

  describe("encodeDelegation", () => {
    it("should create task events for each recipient", () => {
      const intent: DelegationIntent = {
        
        recipients: ["recipient1", "recipient2"],
        title: "Review code",
        request: "Please review the authentication module",
      };

      const tasks = encoder.encodeDelegation(intent, baseContext);

      expect(tasks).toHaveLength(1);

      // Check the single task event
      expect(tasks[0].kind).toBe(1111); // GenericReply kind for delegations
      expect(tasks[0].content).toBe("Please review the authentication module");

      // Check both recipients are tagged
      const pTags = tasks[0].getMatchingTags("p");
      expect(pTags).toHaveLength(2);
      expect(pTags[0][1]).toBe("recipient1"); // First recipient
      expect(pTags[1][1]).toBe("recipient2"); // Second recipient
    });

    it("should include phase information when provided", () => {
      const contextWithPhase: EventContext = {
        ...baseContext,
        phase: "implementation",
      };

      const intent: DelegationIntent = {
        
        recipients: ["reviewer"],
        title: "Phase 2 Review",
        request: "Review implementation",
      };

      const tasks = encoder.encodeDelegation(intent, contextWithPhase);

      expect(tasks[0].tagValue("phase")).toBe("implementation");
    });

    it("should link to triggering event", () => {
      const intent: DelegationIntent = {
        
        recipients: ["agent456"],
        title: "Task",
        request: "Do something",
      };

      const tasks = encoder.encodeDelegation(intent, baseContext);

      const eTags = tasks[0].getMatchingTags("e");
      expect(eTags).toHaveLength(1);
      expect(eTags[0]).toEqual(["e", "trigger123"]); // References triggering event
    });
  });


  describe("encodeConversation", () => {
    it("should create a simple response without completion semantics", () => {
      const intent: ConversationIntent = {
        
        content: "I'm still working on this...",
      };

      const event = encoder.encodeConversation(intent, baseContext);

      expect(event.kind).toBe(NDKKind.GenericReply);
      expect(event.content).toBe("I'm still working on this...");

      // Check conversation tags
      const eTags = event.getMatchingTags("e");
      expect(eTags).toHaveLength(1); // Only triggering event tag
      expect(eTags[0]).toEqual(["e", "trigger123"]); // References triggering event
    });
  });
});

describe("AgentEventDecoder", () => {
  // These tests use simple mocks since they only test static utility functions
  describe("isTaskCompletionEvent", () => {
    it("should not identify events with only status tag as task completions", () => {
      const event = createMockNDKEvent();
      event.tags = [
        ["status", "complete"]
      ];

      expect(AgentEventDecoder.isTaskCompletionEvent(event)).toBe(false);
    });

    it("should identify task completion by K and P tags matching", () => {
      const event = createMockNDKEvent();
      event.tags = [
        ["K", "1934"],
        ["P", "agent123"],
        ["p", "agent123"]
      ];

      expect(AgentEventDecoder.isTaskCompletionEvent(event)).toBe(true);
    });

    it("should not identify regular events as task completions", () => {
      const event = createMockNDKEvent();
      event.tags = [["e", "event123", "", "reply"]];

      expect(AgentEventDecoder.isTaskCompletionEvent(event)).toBe(false);
    });
  });

  describe("getConversationRoot", () => {
    it("should extract conversation root from E tag", () => {
      const event = createMockNDKEvent();
      event.tags = [["E", "root123"]];

      expect(AgentEventDecoder.getConversationRoot(event)).toBe("root123");
    });

    it("should extract conversation root from A tag if no E tag", () => {
      const event = createMockNDKEvent();
      event.tags = [["A", "31933:pubkey:project"]];

      expect(AgentEventDecoder.getConversationRoot(event)).toBe("31933:pubkey:project");
    });
  });

  describe("isDirectedToSystem", () => {
    it("should identify events directed to system agents", () => {
      const systemAgents = new Map([
        ["agent1", { pubkey: "agent123" } as any],
        ["agent2", { pubkey: "agent456" } as any]
      ]);
      
      const event = createMockNDKEvent();
      event.tags = [["p", "agent123"]];

      expect(AgentEventDecoder.isDirectedToSystem(event, systemAgents)).toBe(true);
    });

    it("should not identify events without system agent mentions", () => {
      const systemAgents = new Map([
        ["agent1", { pubkey: "agent123" } as any]
      ]);
      
      const event = createMockNDKEvent();
      event.tags = [["p", "user789"]];

      expect(AgentEventDecoder.isDirectedToSystem(event, systemAgents)).toBe(false);
    });
  });
});
