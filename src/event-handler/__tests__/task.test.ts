import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import { createMockAgent } from "@/test-utils";
import type { NDKTask } from "@nostr-dev-kit/ndk";
import { handleTask } from "../task";

describe("handleTask", () => {
  let mockConversationCoordinator: ConversationCoordinator;
  let mockAgentExecutor: AgentExecutor;
  let mockAgent: AgentInstance;
  let mockOrchestratorAgent: AgentInstance;
  let mockProjectContext: any;
  let mockEvent: NDKTask;

  beforeEach(() => {
    // Reset mocks
    mock.restore();

    // Create mock agents
    mockAgent = createMockAgent({
      name: "TestAgent",
      publicKey: "agent-pubkey-123",
      pubkey: "agent-pubkey-123",
    });

    mockOrchestratorAgent = createMockAgent({
      name: "Orchestrator",
      publicKey: "orchestrator-pubkey",
      pubkey: "orchestrator-pubkey",
    });

    // Mock project context
    mockProjectContext = {
      agents: new Map([
        ["TestAgent", mockAgent],
        ["Orchestrator", mockOrchestratorAgent],
      ]),
      getProjectAgent: () => mockOrchestratorAgent,
      projectPath: "/test/project",
    };

    // Mock getProjectContext
    mock.module("@/services", () => ({
      getProjectContext: () => mockProjectContext,
    }));

    // Create mock conversation manager
    mockConversationCoordinator = {
      createConversation: mock(() =>
        Promise.resolve({
          id: "test-conversation-id",
          phase: "CHAT",
        })
      ),
    } as any;

    // Create mock agent executor
    mockAgentExecutor = {
      execute: mock(() => Promise.resolve()),
    } as any;

    // Create mock event
    mockEvent = {
      title: "Test Task",
      content: "This is a test task content",
      tags: [],
      tagValue: mock((tag: string) => (tag === "claude-session" ? "test-session-id" : undefined)),
    } as any;
  });

  it("should create conversation and route to orchestrator when no p-tags", async () => {
    await handleTask(mockEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Verify conversation was created
    expect(mockConversationCoordinator.createConversation).toHaveBeenCalledWith(mockEvent);

    // Verify executor was called with orchestrator
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: mockOrchestratorAgent,
        conversationId: "test-conversation-id",
        phase: "CHAT",
        triggeringEvent: mockEvent,
        claudeSessionId: "test-session-id",
      })
    );
  });

  it("should route to p-tagged agent when matching pubkey found", async () => {
    // Add p-tag for specific agent
    mockEvent.tags = [["p", "agent-pubkey-123"]];

    await handleTask(mockEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Verify executor was called with the p-tagged agent
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: mockAgent,
        conversationId: "test-conversation-id",
      })
    );
  });

  it("should not route when p-tags don't match any system agents", async () => {
    // Add p-tag for unknown agent
    mockEvent.tags = [["p", "unknown-pubkey"]];

    await handleTask(mockEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Verify conversation was created but no execution happened
    expect(mockConversationCoordinator.createConversation).toHaveBeenCalled();
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
  });

  it("should handle multiple p-tags and use first matching agent", async () => {
    // Add multiple p-tags
    mockEvent.tags = [
      ["p", "unknown-pubkey-1"],
      ["p", "agent-pubkey-123"],
      ["p", "orchestrator-pubkey"],
    ];

    await handleTask(mockEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Should route to first matching agent (TestAgent)
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: mockAgent,
      })
    );
  });

  it("should handle conversation creation failure gracefully", async () => {
    // Make conversation creation fail
    mockConversationCoordinator.createConversation = mock(() =>
      Promise.reject(new Error("Failed to create conversation"))
    );

    // Should not throw
    await expect(
      handleTask(mockEvent, {
        conversationManager: mockConversationCoordinator,
        agentExecutor: mockAgentExecutor,
      })
    ).resolves.toBeUndefined();

    // Executor should not be called
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
  });

  it("should handle agent execution failure gracefully", async () => {
    // Make agent execution fail
    mockAgentExecutor.execute = mock(() => Promise.reject(new Error("Agent execution failed")));

    // Should not throw
    await expect(
      handleTask(mockEvent, {
        conversationManager: mockConversationCoordinator,
        agentExecutor: mockAgentExecutor,
      })
    ).resolves.toBeUndefined();

    // Conversation should still be created
    expect(mockConversationCoordinator.createConversation).toHaveBeenCalled();
  });

  it("should pass claude session ID when present", async () => {
    await handleTask(mockEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeSessionId: "test-session-id",
      })
    );
  });

  it("should handle missing claude session ID", async () => {
    // Remove claude-session tag
    mockEvent.tagValue = mock(() => undefined);

    await handleTask(mockEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeSessionId: undefined,
      })
    );
  });

  it("should handle long content by truncating in logs", async () => {
    // Create long content
    mockEvent.content = "a".repeat(200);

    await handleTask(mockEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Should still process normally
    expect(mockConversationCoordinator.createConversation).toHaveBeenCalled();
    expect(mockAgentExecutor.execute).toHaveBeenCalled();
  });
});
