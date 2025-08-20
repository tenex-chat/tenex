import { NDKEvent, NDKKind } from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";
import { EVENT_KINDS } from "@/llm/types";
import { AgentEventDecoder } from "../AgentEventDecoder";
import {
  AgentEventEncoder,
  type CompletionIntent,
  type ConversationIntent,
  type DelegationIntent,
  type EventContext,
} from "../AgentEventEncoder";

describe("AgentEventEncoder", () => {
  const mockAgent: AgentInstance = {
    name: "TestAgent",
    pubkey: "agent123",
    slug: "test-agent",
    signer: {} as any,
    llmConfig: "test-config",
  };

  const mockTriggeringEvent = new NDKEvent();
  mockTriggeringEvent.id = "trigger123";
  mockTriggeringEvent.tags = [
    ["e", "root123", "", "root"],
    ["e", "reply123", "", "reply"],
  ];

  const mockConversationEvent = new NDKEvent();
  mockConversationEvent.id = "conv123";
  mockConversationEvent.content = "Initial conversation";

  const baseContext: EventContext = {
    agent: mockAgent,
    triggeringEvent: mockTriggeringEvent,
    conversationEvent: mockConversationEvent,
  };

  describe("encodeCompletion", () => {
    it("should encode a basic completion intent", () => {
      const intent: CompletionIntent = {
        type: "completion",
        content: "Task completed successfully",
      };

      const event = AgentEventEncoder.encodeCompletion(intent, baseContext);

      expect(event.kind).toBe(NDKKind.GenericReply);
      expect(event.content).toBe("Task completed successfully");

      // Check E-tags are marked as completed
      const eTags = event.getMatchingTags("e");
      expect(eTags).toHaveLength(2);
      expect(eTags[0]).toEqual(["e", "root123", "", "completed"]);
      expect(eTags[1]).toEqual(["e", "reply123", "", "completed"]);
    });

    it("should include optional completion metadata", () => {
      const intent: CompletionIntent = {
        type: "completion",
        content: "Analysis complete",
        summary: "Found 3 issues",
      };

      const event = AgentEventEncoder.encodeCompletion(intent, baseContext);

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
        type: "completion",
        content: "Done",
      };

      const event = AgentEventEncoder.encodeCompletion(intent, contextWithMetadata);

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

    it("should format complete tool tags correctly without arguments", () => {
      const contextWithCompleteTool: EventContext = {
        ...baseContext,
        toolCalls: [{ name: "complete", arguments: { response: "Task completed successfully" } }],
      };

      const intent: CompletionIntent = {
        type: "completion",
        content: "Task completed successfully",
      };

      const event = AgentEventEncoder.encodeCompletion(intent, contextWithCompleteTool);

      const toolTags = event.getMatchingTags("tool");
      expect(toolTags).toHaveLength(1);
      expect(toolTags[0]).toEqual(["tool", "complete"]); // Should only have 2 elements, no arguments
      expect(toolTags[0]).toHaveLength(2); // Explicitly check length
    });

    it("should include phase information when provided", () => {
      const contextWithPhase: EventContext = {
        ...baseContext,
        phase: "implementation",
      };

      const intent: CompletionIntent = {
        type: "completion",
        content: "Implementation completed",
      };

      const event = AgentEventEncoder.encodeCompletion(intent, contextWithPhase);

      expect(event.tagValue("phase")).toBe("implementation");
    });
  });

  describe("encodeDelegation", () => {
    it("should create task events for each recipient", () => {
      const intent: DelegationIntent = {
        type: "delegation",
        recipients: ["recipient1", "recipient2"],
        title: "Review code",
        request: "Please review the authentication module",
      };

      const tasks = AgentEventEncoder.encodeDelegation(intent, baseContext);

      expect(tasks).toHaveLength(2);

      // Check first task
      expect(tasks[0].kind).toBe(EVENT_KINDS.TASK);
      expect(tasks[0].content).toBe("Please review the authentication module");
      expect(tasks[0].title).toBe("Review code");

      const pTag1 = tasks[0].getMatchingTags("p")[0];
      expect(pTag1).toEqual(["p", "recipient1", "", "agent"]);

      // Check second task
      const pTag2 = tasks[1].getMatchingTags("p")[0];
      expect(pTag2).toEqual(["p", "recipient2", "", "agent"]);
    });

    it("should include phase information when provided", () => {
      const contextWithPhase: EventContext = {
        ...baseContext,
        phase: "implementation",
      };

      const intent: DelegationIntent = {
        type: "delegation",
        recipients: ["reviewer"],
        title: "Phase 2 Review",
        request: "Review implementation",
      };

      const tasks = AgentEventEncoder.encodeDelegation(intent, contextWithPhase);

      expect(tasks[0].tagValue("phase")).toBe("implementation");
    });

    it("should link to triggering event", () => {
      const intent: DelegationIntent = {
        type: "delegation",
        recipients: ["agent456"],
        title: "Task",
        request: "Do something",
      };

      const tasks = AgentEventEncoder.encodeDelegation(intent, baseContext);

      const eTags = tasks[0].getMatchingTags("e");
      expect(eTags).toContainEqual(["e", "trigger123", "", "delegation-trigger"]);
    });
  });

  describe("encodeConversation", () => {
    it("should create a simple response without completion semantics", () => {
      const intent: ConversationIntent = {
        type: "conversation",
        content: "I'm still working on this...",
      };

      const event = AgentEventEncoder.encodeConversation(intent, baseContext);

      expect(event.kind).toBe(NDKKind.GenericReply);
      expect(event.content).toBe("I'm still working on this...");

      // Check E-tags are marked as reply, not completed
      const eTags = event.getMatchingTags("e");
      expect(eTags).toHaveLength(2);
      expect(eTags[0]).toEqual(["e", "root123", "", "reply"]);
      expect(eTags[1]).toEqual(["e", "reply123", "", "reply"]);
    });
  });
});

describe("AgentEventDecoder", () => {
  describe("isCompletionEvent", () => {
    it("should identify completion events by completed e-tags", () => {
      const event = new NDKEvent();
      event.tags = [["e", "event123", "", "completed"]];

      expect(AgentEventDecoder.isCompletionEvent(event)).toBe(true);
    });

    it("should not identify regular replies as completions", () => {
      const event = new NDKEvent();
      event.tags = [["e", "event123", "", "reply"]];

      expect(AgentEventDecoder.isCompletionEvent(event)).toBe(false);
    });
  });

  describe("decodeCompletion", () => {
    it("should decode completion events back to intents", () => {
      const event = new NDKEvent();
      event.content = "Task finished";
      event.tags = [
        ["e", "event123", "", "completed"],
        ["summary", "All tests passed"],
      ];

      const intent = AgentEventDecoder.decodeCompletion(event);

      expect(intent).toEqual({
        type: "completion",
        content: "Task finished",
        summary: "All tests passed",
      });
    });

    it("should return null for non-completion events", () => {
      const event = new NDKEvent();
      event.tags = [["e", "event123", "", "reply"]];

      expect(AgentEventDecoder.decodeCompletion(event)).toBeNull();
    });
  });

  describe("isDelegationEvent", () => {
    it("should identify task events with agent p-tags", () => {
      const event = new NDKEvent();
      event.kind = EVENT_KINDS.TASK;
      event.tags = [["p", "agent123", "", "agent"]];

      expect(AgentEventDecoder.isDelegationEvent(event)).toBe(true);
    });

    it("should not identify regular tasks as delegations", () => {
      const event = new NDKEvent();
      event.kind = EVENT_KINDS.TASK;
      event.tags = [["p", "user123", "", "assignee"]];

      expect(AgentEventDecoder.isDelegationEvent(event)).toBe(false);
    });
  });

  describe("extractContext", () => {
    it("should extract all metadata from an event", () => {
      const event = new NDKEvent();
      event.tags = [
        ["conversation-id", "conv123"],
        ["project", "proj456"],
        ["llm-model", "claude-3"],
        ["execution-time", "2500"],
        ["llm-prompt-tokens", "200"],
        ["llm-completion-tokens", "100"],
        ["llm-total-tokens", "300"],
        ["tool", "search", '{"query":"test"}'],
        ["tool", "calculate", '{"expression":"2+2"}'],
      ];

      const context = AgentEventDecoder.extractContext(event);

      expect(context.conversationId).toBe("conv123");
      expect(context.projectId).toBe("proj456");
      expect(context.model).toBe("claude-3");
      expect(context.executionTime).toBe(2500);
      expect(context.usage).toEqual({
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
      });
      expect(context.toolCalls).toEqual([
        { name: "search", arguments: { query: "test" } },
        { name: "calculate", arguments: { expression: "2+2" } },
      ]);
    });
  });
});
