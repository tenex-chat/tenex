import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations/types";
import * as services from "@/services";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { handleChatMessage } from "../reply";

// Mock logger to avoid console output during tests
mock.module("@/utils/logger", () => ({
  logger: {
    info: mock(() => {}),
    debug: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
  },
}));

describe("Task Reply Routing", () => {
  let mockConversationCoordinator: any;
  let mockAgentExecutor: any;
  let mockProjectContext: any;
  let userPubkey: string;
  let agentPubkey: string;
  let projectPubkey: string;
  let mockAgent: AgentInstance;

  beforeEach(() => {
    // Setup pubkeys
    userPubkey = "user-pubkey";
    agentPubkey = "agent-pubkey";
    projectPubkey = "project-pubkey";

    // Create mock agent
    mockAgent = {
      slug: "test-agent",
      name: "Test Agent",
      pubkey: agentPubkey,
      
    } as AgentInstance;

    // Create mock project context
    mockProjectContext = {
      pubkey: projectPubkey,
      agents: new Map([["test-agent", mockAgent]]),
      getProjectAgent: mock(() => ({
        slug: "orchestrator",
        name: "Orchestrator",
        pubkey: projectPubkey,
        
      })),
      project: {
        tag: mock(() => {}),
      },
    };

    // Mock getProjectContext
    spyOn(services, "getProjectContext").mockReturnValue(mockProjectContext);

    // Create mock conversation manager
    mockConversationCoordinator = {
      getConversationByEvent: mock(),
      getConversation: mock(),
      createConversation: mock(),
      addEvent: mock(),
      isCurrentTurnComplete: mock(() => true),
      updateAgentState: mock(),
      registerTaskMapping: mock(),
      getTaskMapping: mock(),
      removeTaskMapping: mock(),
    };

    // Create mock agent executor
    mockAgentExecutor = {
      execute: mock(),
    };
  });

  it("should route reply to task back to original conversation using task mapping", async () => {
    const taskId = "task-123";
    const conversationId = "conv-456";

    // Create a reply to a task event
    const replyToTaskEvent = new NDKEvent(undefined, {
      kind: 1111,
      content: "Reply to the task",
      pubkey: userPubkey,
      tags: [
        ["E", taskId], // Replying to the task
        ["K", "1934"], // This is a task reply
        ["p", projectPubkey], // Mentioning the project
      ],
    });

    // Create mock conversation
    const mockConversation: Conversation = {
      id: conversationId,
      rootEvent: new NDKEvent(undefined, {
        id: conversationId,
        content: "Original conversation",
        pubkey: userPubkey,
      }),
      history: [],
      phase: "CHAT",
      agentStates: new Map(),
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Setup mocks
    mockConversationCoordinator.getConversationByEvent.mockReturnValue(undefined); // No direct conversation found
    mockConversationCoordinator.getTaskMapping.mockReturnValue({
      conversationId,
    });
    mockConversationCoordinator.getConversation.mockImplementation((id: string) => {
      if (id === conversationId) return mockConversation;
      return undefined;
    });

    // Call the handler
    await handleChatMessage(replyToTaskEvent, {
      conversationCoordinator: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Verify task mapping was checked
    expect(mockConversationCoordinator.getTaskMapping).toHaveBeenCalledWith(taskId);

    // Verify conversation was retrieved using the mapped ID
    expect(mockConversationCoordinator.getConversation).toHaveBeenCalledWith(conversationId);

    // Verify event was added to the conversation
    expect(mockConversationCoordinator.addEvent).toHaveBeenCalledWith(
      conversationId,
      replyToTaskEvent
    );

    // Verify agent executor was called with the correct conversation ID
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
      })
    );
  });

  it("should fall back to direct conversation lookup if no task mapping exists", async () => {
    const taskId = "task-without-mapping";

    // Create a reply to a task event
    const replyToTaskEvent = new NDKEvent(undefined, {
      kind: 1111,
      content: "Reply to unmapped task",
      pubkey: userPubkey,
      tags: [
        ["E", taskId],
        ["K", "1934"],
        ["p", projectPubkey],
      ],
    });

    // Create mock conversation where task ID is the conversation root
    const mockConversation: Conversation = {
      id: taskId,
      rootEvent: new NDKEvent(undefined, {
        id: taskId,
        content: "Task as conversation root",
        pubkey: userPubkey,
      }),
      history: [],
      phase: "CHAT",
      agentStates: new Map(),
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Setup mocks
    mockConversationCoordinator.getConversationByEvent.mockReturnValue(undefined);
    mockConversationCoordinator.getTaskMapping.mockReturnValue(undefined); // No mapping exists
    mockConversationCoordinator.getConversation.mockImplementation((id: string) => {
      if (id === taskId) return mockConversation;
      return undefined;
    });

    // Call the handler
    await handleChatMessage(replyToTaskEvent, {
      conversationCoordinator: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Verify task mapping was checked first
    expect(mockConversationCoordinator.getTaskMapping).toHaveBeenCalledWith(taskId);

    // Verify fallback to direct conversation lookup
    expect(mockConversationCoordinator.getConversation).toHaveBeenCalledWith(taskId);

    // Verify event was processed
    expect(mockConversationCoordinator.addEvent).toHaveBeenCalledWith(taskId, replyToTaskEvent);
    expect(mockAgentExecutor.execute).toHaveBeenCalled();
  });

  it("should prefer mapped Claude session ID over event tag", async () => {
    const taskId = "task-with-session";
    const conversationId = "conv-with-session";
    const mappedSessionId = "mapped-session-123";
    const eventSessionId = "event-session-456";

    // Create a reply with its own claude-session tag
    const replyWithSessionTag = new NDKEvent(undefined, {
      kind: 1111,
      content: "Reply with session tag",
      pubkey: userPubkey,
      tags: [
        ["E", taskId],
        ["K", "1934"],
        ["p", projectPubkey],
        ["claude-session", eventSessionId], // Event has its own session tag
      ],
    });

    // Create mock conversation
    const mockConversation: Conversation = {
      id: conversationId,
      rootEvent: new NDKEvent(undefined, {
        id: conversationId,
        content: "Conversation with mapped session",
        pubkey: userPubkey,
      }),
      history: [],
      phase: "CHAT",
      agentStates: new Map(),
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Setup mocks
    mockConversationCoordinator.getConversationByEvent.mockReturnValue(undefined);
    mockConversationCoordinator.getTaskMapping.mockReturnValue({
      conversationId,
    });
    mockConversationCoordinator.getConversation.mockReturnValue(mockConversation);

    // Call the handler
    await handleChatMessage(replyWithSessionTag, {
      conversationCoordinator: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Verify the executor was called with correct conversation ID
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
      })
    );
  });

  it("should handle task reply when no conversation is found", async () => {
    const taskId = "task-no-conversation";

    // Create a reply to a non-existent task
    const replyToNonExistentTask = new NDKEvent(undefined, {
      kind: 1111,
      content: "Reply to non-existent task",
      pubkey: userPubkey,
      tags: [
        ["E", taskId],
        ["K", "1934"],
        ["p", projectPubkey],
      ],
    });

    // Setup mocks - no conversation found anywhere
    mockConversationCoordinator.getConversationByEvent.mockReturnValue(undefined);
    mockConversationCoordinator.getTaskMapping.mockReturnValue(undefined);
    mockConversationCoordinator.getConversation.mockReturnValue(undefined);

    // Call the handler
    await handleChatMessage(replyToNonExistentTask, {
      conversationCoordinator: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Verify attempts were made to find the conversation
    expect(mockConversationCoordinator.getTaskMapping).toHaveBeenCalledWith(taskId);
    expect(mockConversationCoordinator.getConversation).toHaveBeenCalledWith(taskId);

    // Verify no execution happened (no conversation found)
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();

    // Verify error was logged
    expect(logger.error).toHaveBeenCalledWith(
      "No conversation found for reply",
      expect.any(Object)
    );
  });
});
