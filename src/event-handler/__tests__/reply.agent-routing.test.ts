import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentExecutor } from "../../agents/execution/AgentExecutor";
import type { ConversationCoordinator } from "../../conversations";
import { DelegationRegistry } from "../../services/DelegationRegistry";
import { handleChatMessage } from "../reply";

// Mock dependencies
mock.module("../../utils/logger", () => ({
  logger: {
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
  },
}));

describe("Agent Event Routing", () => {
  let mockConversationCoordinator: ConversationCoordinator;
  let mockAgentExecutor: AgentExecutor;
  let mockProjectContext: any;

  beforeEach(async () => {
    // Reset mocks
    mock.restore();
    
    // Initialize DelegationRegistry before each test
    await DelegationRegistry.initialize();

    // Create mock conversation manager
    mockConversationCoordinator = {
      getConversationByEvent: mock(() => undefined),
      getConversation: mock(() => undefined),
      getTaskMapping: mock(() => undefined),
      createConversation: mock(() => Promise.resolve(undefined)),
      addEvent: mock(() => Promise.resolve()),
      updateAgentState: mock(() => Promise.resolve()),
    } as any;

    // Create mock agent executor
    mockAgentExecutor = {
      execute: mock(() => Promise.resolve()),
    } as any;

    // Create mock project context with agents
    // First agent in the map becomes the PM dynamically
    const pmAgent = {
      name: "primary-agent",
      pubkey: "pm-agent-pubkey",
      slug: "primary-agent",
      eventId: "pm-event-id",
    };
    
    mockProjectContext = {
      pubkey: "project-pubkey",
      agents: new Map([
        [
          "primary-agent",  // This is now the PM (first agent)
          pmAgent,
        ],
        [
          "code-agent",
          {
            name: "code-agent",
            pubkey: "code-agent-pubkey",
            slug: "code-agent",
            eventId: "code-event-id",
          },
        ],
      ]),
      getAgent: (slug: string) => mockProjectContext.agents.get(slug),
      getProjectManager: () => pmAgent,  // Dynamic PM getter
    };

    // Mock getProjectContext
    mock.module("../../services", () => ({
      getProjectContext: () => mockProjectContext,
    }));
  });

  it("should not route agent events without p-tags", async () => {
    // Create an event from an agent without p-tags
    const agentEvent: NDKEvent = {
      id: "event-1",
      pubkey: "code-agent-pubkey", // Agent pubkey
      content: "Agent reporting something",
      kind: 1111,
      tags: [
        ["E", "conv-root"],
        ["K", "11"],
      ],
      tagValue: (tag: string) => {
        if (tag === "E") return "conv-root";
        if (tag === "K") return "11";
        return undefined;
      },
      getMatchingTags: (tag: string) => {
        if (tag === "p") return [];
        return [];
      },
    } as any;

    // Handle the event
    await handleChatMessage(agentEvent, {
      conversationCoordinator: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Agent executor should NOT be called since the event shouldn't be routed
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
  });

  it("should route user events without p-tags to PM", async () => {
    // Create an event from a user without p-tags
    const userEvent: NDKEvent = {
      id: "event-2",
      pubkey: "user-pubkey", // Not an agent pubkey
      content: "User message",
      kind: 1111,
      tags: [
        ["E", "conv-root"],
        ["K", "11"],
      ],
      tagValue: (tag: string) => {
        if (tag === "E") return "conv-root";
        if (tag === "K") return "11";
        return undefined;
      },
      getMatchingTags: (tag: string) => {
        if (tag === "p") return [];
        return [];
      },
    } as any;

    // Create a mock conversation
    const mockConversation = {
      id: "conv-root",
      history: [],
      phase: "chat",
      phaseTransitions: [],
      agentStates: new Map(),
    };

    // Update mock to return conversation
    mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

    // Handle the event
    await handleChatMessage(userEvent, {
      conversationCoordinator: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Agent executor should be called since user events should be routed to PM
    expect(mockAgentExecutor.execute).toHaveBeenCalled();

    // Check that the execution context has the PM as target agent
    const executionCall = (mockAgentExecutor.execute as any).mock.calls[0];
    const executionContext = executionCall[0];
    expect(executionContext.agent.slug).toBe("primary-agent"); // Dynamic PM
  });

  it("should route events with multiple p-tags to all tagged agents", async () => {
    // Create an event with multiple p-tags
    const multiPtagEvent: NDKEvent = {
      id: "event-multi",
      pubkey: "user-pubkey", // User event
      content: "Message to multiple agents",
      kind: 1111,
      tags: [
        ["E", "conv-root"],
        ["K", "11"],
        ["p", "pm-agent-pubkey"],
        ["p", "code-agent-pubkey"],
      ],
      tagValue: (tag: string) => {
        if (tag === "E") return "conv-root";
        if (tag === "K") return "11";
        return undefined;
      },
      getMatchingTags: (tag: string) => {
        if (tag === "p") {
          return [
            ["p", "pm-agent-pubkey"],
            ["p", "code-agent-pubkey"],
          ];
        }
        if (tag === "E") return [["E", "conv-root"]];
        return [];
      },
    } as any;

    // Mock conversation lookup to return a conversation
    mockConversationCoordinator.getConversationByEvent = mock(() => ({
      id: "conv-1",
      history: [],
      phase: "chat",
    }));

    // Handle the event
    await handleChatMessage(multiPtagEvent, {
      conversationCoordinator: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Agent executor should be called twice - once for each p-tagged agent
    expect(mockAgentExecutor.execute).toHaveBeenCalledTimes(2);
    
    // Verify both agents were executed
    const calls = (mockAgentExecutor.execute as any).mock.calls;
    const executedAgents = calls.map((call: any[]) => call[0].agent.slug);
    expect(executedAgents).toContain("primary-agent"); // Dynamic PM
    expect(executedAgents).toContain("code-agent");
  });

  it("should filter out self-replies when multiple agents are p-tagged", async () => {
    // Create an event from PM that p-tags PM and code-agent
    const selfReplyEvent: NDKEvent = {
      id: "event-self",
      pubkey: "pm-agent-pubkey", // PM sending the event
      content: "Message from PM to PM and code-agent",
      kind: 1111,
      tags: [
        ["E", "conv-root"],
        ["K", "11"],
        ["p", "pm-agent-pubkey"], // PM tagging itself
        ["p", "code-agent-pubkey"],
      ],
      tagValue: (tag: string) => {
        if (tag === "E") return "conv-root";
        if (tag === "K") return "11";
        return undefined;
      },
      getMatchingTags: (tag: string) => {
        if (tag === "p") {
          return [
            ["p", "pm-agent-pubkey"],
            ["p", "code-agent-pubkey"],
          ];
        }
        if (tag === "E") return [["E", "conv-root"]];
        return [];
      },
    } as any;

    // Mock conversation lookup to return a conversation
    mockConversationCoordinator.getConversationByEvent = mock(() => ({
      id: "conv-1",
      history: [],
      phase: "chat",
    }));

    // Handle the event
    await handleChatMessage(selfReplyEvent, {
      conversationCoordinator: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Agent executor should be called only once - for code-agent (PM filtered out due to self-reply)
    expect(mockAgentExecutor.execute).toHaveBeenCalledTimes(1);
    
    // Verify only code-agent was executed
    const calls = (mockAgentExecutor.execute as any).mock.calls;
    const executedAgents = calls.map((call: any[]) => call[0].agent.slug);
    expect(executedAgents).toEqual(["code-agent"]);
  });

  it("should route agent events with p-tags to the tagged agent", async () => {
    // Create an event from an agent with p-tags
    const agentEvent: NDKEvent = {
      id: "event-3",
      pubkey: "code-agent-pubkey", // Agent pubkey
      content: "Agent message to PM",
      kind: 1111,
      tags: [
        ["E", "conv-root"],
        ["K", "11"],
        ["p", "pm-agent-pubkey"], // P-tagging the PM
      ],
      tagValue: (tag: string) => {
        if (tag === "E") return "conv-root";
        if (tag === "K") return "11";
        if (tag === "p") return "pm-agent-pubkey";
        return undefined;
      },
      getMatchingTags: (tag: string) => {
        if (tag === "p") return [["p", "pm-agent-pubkey"]];
        return [];
      },
    } as any;

    // Create a mock conversation
    const mockConversation = {
      id: "conv-root",
      history: [],
      phase: "chat",
      phaseTransitions: [],
      agentStates: new Map(),
    };

    // Update mock to return conversation
    mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

    // Handle the event
    await handleChatMessage(agentEvent, {
      conversationCoordinator: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Agent executor should be called
    expect(mockAgentExecutor.execute).toHaveBeenCalled();

    // Check that the execution context has the PM as target agent
    const executionCall = (mockAgentExecutor.execute as any).mock.calls[0];
    const executionContext = executionCall[0];
    expect(executionContext.agent.slug).toBe("primary-agent"); // Dynamic PM
  });
});
