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
  type StatusIntent,
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
      expect(eTags[0]).toEqual(["e", "conv123"]); // References the conversation event
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
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
        toolCalls: [{ name: "search", arguments: { query: "test" } }],
      };

      const intent: CompletionIntent = {
        
        content: "Done",
      };

      const event = encoder.encodeCompletion(intent, contextWithMetadata);

      expect(event.tagValue("llm-model")).toBe("gpt-4");
      expect(event.tagValue("execution-time")).toBe("1500");
      expect(event.tagValue("llm-prompt-tokens")).toBe("100");
      expect(event.tagValue("llm-completion-tokens")).toBe("50");
      expect(event.tagValue("llm-total-tokens")).toBe("150");

      const toolTags = event.getMatchingTags("tool");
      expect(toolTags).toHaveLength(1);
      expect(toolTags[0]).toEqual(["tool", "search"]); // Now only 2 elements
      expect(toolTags[0]).toHaveLength(2);
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

      expect(tasks).toHaveLength(2);

      // Check first task
      expect(tasks[0].kind).toBe(1934); // NDKTask.kind
      expect(tasks[0].content).toBe("Please review the authentication module");
      expect(tasks[0].title).toBe("Review code");

      const pTag1 = tasks[0].getMatchingTags("p")[0];
      expect(pTag1[1]).toBe("recipient1"); // Check recipient pubkey

      // Check second task
      const pTag2 = tasks[1].getMatchingTags("p")[0];
      expect(pTag2[1]).toBe("recipient2"); // Check recipient pubkey
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
      expect(eTags).toContainEqual(["e", "conv123"]); // References conversation event
    });
  });

  describe("encodeProjectStatus", () => {
    beforeEach(() => {
      // Setup mock project context for status tests
      const mockProjectContext = {
        project: {
          pubkey: "projectOwner123",
          tagReference: () => ["a", "31933:projectOwner123:test-project"],
        },
      };
      (getProjectContext as ReturnType<typeof mock>).mockReturnValue(mockProjectContext);
    });

    it("should encode project status with owner p-tag", () => {
      const intent: StatusIntent = {
        type: "status",
        agents: [
          { pubkey: "agent1", slug: "agent-one" },
          { pubkey: "agent2", slug: "agent-two" },
        ],
        models: [
          { slug: "gpt-4", agents: ["agent-one"] },
        ],
        tools: [
          { name: "search", agents: ["agent-one", "agent-two"] },
        ],
      };

      const event = encoder.encodeProjectStatus(intent);

      // Check event kind
      expect(event.kind).toBe(EVENT_KINDS.PROJECT_STATUS);
      expect(event.content).toBe("");

      // Check project reference tag
      const aTags = event.getMatchingTags("a");
      expect(aTags).toHaveLength(1);
      expect(aTags[0]).toEqual(["a", "31933:projectOwner123:test-project"]);

      // Check p-tag for project owner
      const pTags = event.getMatchingTags("p");
      expect(pTags).toHaveLength(1);
      expect(pTags[0]).toEqual(["p", "projectOwner123"]);

      // Check agent tags
      const agentTags = event.getMatchingTags("agent");
      expect(agentTags).toHaveLength(2);
      expect(agentTags[0]).toEqual(["agent", "agent1", "agent-one"]);
      expect(agentTags[1]).toEqual(["agent", "agent2", "agent-two"]);

      // Check model tags
      const modelTags = event.getMatchingTags("model");
      expect(modelTags).toHaveLength(1);
      expect(modelTags[0]).toEqual(["model", "gpt-4", "agent-one"]);

      // Check tool tags
      const toolTags = event.getMatchingTags("tool");
      expect(toolTags).toHaveLength(1);
      expect(toolTags[0]).toEqual(["tool", "search", "agent-one", "agent-two"]);
    });

    it("should include queue tags when provided", () => {
      const intent: StatusIntent = {
        type: "status",
        agents: [],
        models: [],
        tools: [],
        queue: ["conv123", "conv456"],
      };

      const event = encoder.encodeProjectStatus(intent);

      const queueTags = event.getMatchingTags("queue");
      expect(queueTags).toHaveLength(2);
      expect(queueTags[0]).toEqual(["queue", "conv123"]);
      expect(queueTags[1]).toEqual(["queue", "conv456"]);
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
      expect(eTags).toHaveLength(1); // Only conversation event tag
      expect(eTags[0]).toEqual(["e", "conv123"]); // References conversation event
    });
  });
});

describe("AgentEventDecoder", () => {
  // These tests use simple mocks since they only test static utility functions
  describe("isTaskCompletionEvent", () => {
    it("should identify task completion by status tag", () => {
      const event = createMockNDKEvent();
      event.tags = [
        ["status", "complete"]
      ];

      expect(AgentEventDecoder.isTaskCompletionEvent(event)).toBe(true);
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
