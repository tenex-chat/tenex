import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createMockNDKEvent } from "@/test-utils";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { handleNewConversation } from "../newConversation";

describe("handleNewConversation", () => {
  let mockAgentRegistry: any;
  let mockConversationCoordinator: any;
  let mockAgentExecutor: any;
  let mockEvent: NDKEvent;

  beforeEach(() => {
    // Create mock event
    mockEvent = createMockNDKEvent({
      content: "Hello, I need help with a task",
      tags: [
        ["d", "conversation-123"],
        ["agent", "planner"],
      ],
    });

    // Create mock agent registry
    mockAgentRegistry = {
      getAgentBySlug: mock((slug: string) => ({
        id: `agent-${slug}`,
        name: slug,
        slug,
        systemPrompt: `You are the ${slug} agent`,
        tools: ["analyze", "complete"],
        backend: "claude",
      })),
      getDefaultAgent: mock(() => ({
        id: "agent-orchestrator",
        name: "orchestrator",
        slug: "orchestrator",
        systemPrompt: "You are the orchestrator agent",
        tools: [],
        backend: "routing",
      })),
    };

    // Create mock conversation manager
    mockConversationCoordinator = {
      createConversation: mock(async (event: NDKEvent) => ({
        id: event.tags.find((tag) => tag[0] === "d")?.[1] || "conversation-123",
        title: "Test Conversation",
        phase: "CHAT",
        history: [event],
        agentStates: new Map(),
        phaseStartedAt: Date.now(),
        metadata: {},
        phaseTransitions: [],
        executionTime: {
          totalSeconds: 0,
          isActive: false,
          lastUpdated: Date.now(),
        },
      })),
      addMessage: mock(async () => {}),
      updatePhase: mock(async () => {}),
      startOrchestratorTurn: mock(async () => "turn-123"),
      addCompletionToTurn: mock(async () => {}),
    };

    // Create mock agent executor
    mockAgentExecutor = {
      execute: mock(async () => {}),
    };

    // Mock modules
    mock.module("@/services", () => ({
      getProjectContext: () => ({
        agentRegistry: mockAgentRegistry,
        conversationCoordinator: mockConversationCoordinator,
        agents: new Map([
          [
            "orchestrator",
            {
              id: "agent-orchestrator",
              name: "orchestrator",
              slug: "orchestrator",
              pubkey: "orchestrator-pubkey",
              systemPrompt: "You are the orchestrator agent",
              tools: [],
              backend: "routing",
              
            },
          ],
          [
            "planner",
            {
              id: "agent-planner",
              name: "planner",
              slug: "planner",
              pubkey: "planner-pubkey",
              systemPrompt: "You are the planner agent",
              tools: ["analyze", "complete"],
              backend: "claude",
            },
          ],
        ]),
        getProjectAgent: () => ({
          id: "agent-orchestrator",
          name: "orchestrator",
          slug: "orchestrator",
          pubkey: "orchestrator-pubkey",
          systemPrompt: "You are the orchestrator agent",
          tools: [],
          backend: "routing",
          
        }),
      }),
    }));

    mock.module("@/agents/execution/AgentExecutor", () => ({
      AgentExecutor: class {
        execute = mockAgentExecutor.execute;
      },
    }));

    mock.module("@/llm/router", () => ({
      getLLMService: () => ({}),
    }));

    mock.module("@/nostr", () => ({
      getNDK: () => ({}),
    }));

    mock.module("@/utils/logger", () => ({
      logger: {
        info: () => {},
        error: () => {},
        debug: () => {},
      },
    }));

    mock.module("@/tracing", () => ({
      createTracingContext: () => ({ id: "trace-123" }),
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  describe("conversation creation", () => {
    it("should create a new conversation", async () => {
      await handleNewConversation(mockEvent, {
        conversationCoordinator: mockConversationCoordinator,
        agentExecutor: mockAgentExecutor,
      });

      expect(mockConversationCoordinator.createConversation).toHaveBeenCalledWith(mockEvent);
    });

    it("should use specified agent from tags", async () => {
      await handleNewConversation(mockEvent, {
        conversationCoordinator: mockConversationCoordinator,
        agentExecutor: mockAgentExecutor,
      });

      // Agent lookup happens in the function itself, not through registry
      expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conversation-123",
        })
      );
    });

    it("should use default agent when no agent specified", async () => {
      // Remove agent tag
      mockEvent.tags = [["d", "conversation-456"]];

      await handleNewConversation(mockEvent, {
        conversationCoordinator: mockConversationCoordinator,
        agentExecutor: mockAgentExecutor,
      });

      // Default agent is orchestrator
      expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conversation-456",
        })
      );
    });
  });

  describe("error handling", () => {
    it("should handle conversation creation errors", async () => {
      const error = new Error("Failed to create conversation");
      mockConversationCoordinator.createConversation.mockRejectedValue(error);

      // Should not throw
      await expect(
        handleNewConversation(mockEvent, {
          conversationCoordinator: mockConversationCoordinator,
          agentExecutor: mockAgentExecutor,
        })
      ).resolves.toBeUndefined();
    });

    it("should handle agent not found", async () => {
      mockAgentRegistry.getAgentBySlug.mockReturnValue(null);
      mockAgentRegistry.getDefaultAgent.mockReturnValue(null);

      // Should not throw
      await expect(
        handleNewConversation(mockEvent, {
          conversationCoordinator: mockConversationCoordinator,
          agentExecutor: mockAgentExecutor,
        })
      ).resolves.toBeUndefined();
    });

    it("should handle execution errors", async () => {
      const error = new Error("Execution failed");
      mockAgentExecutor.execute.mockRejectedValue(error);

      // Should not throw
      await expect(
        handleNewConversation(mockEvent, {
          conversationCoordinator: mockConversationCoordinator,
          agentExecutor: mockAgentExecutor,
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("event validation", () => {
    it("should handle missing conversation ID", async () => {
      mockEvent.tags = [];

      // Should not throw
      await expect(
        handleNewConversation(mockEvent, {
          conversationCoordinator: mockConversationCoordinator,
          agentExecutor: mockAgentExecutor,
        })
      ).resolves.toBeUndefined();
    });

    it("should handle empty content", async () => {
      mockEvent.content = "";

      await handleNewConversation(mockEvent, {
        conversationCoordinator: mockConversationCoordinator,
        agentExecutor: mockAgentExecutor,
      });

      // Should still create conversation with empty content
      expect(mockConversationCoordinator.createConversation).toHaveBeenCalledWith(mockEvent);
    });
  });
});
