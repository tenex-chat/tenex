import { NDKEvent, NDKUser } from "@nostr-dev-kit/ndk";
import { mock, mockReset } from "jest-mock-extended";
import type { AgentExecutor } from "../../agents/execution/AgentExecutor";
import type { Agent } from "../../agents/types";
import { Conversation } from "../../conversations";
import type { ConversationCoordinator } from "../../conversations/ConversationCoordinator";
import { getProjectContext, setProjectContext } from "../../services";
import type { ProjectContext } from "../../services/ProjectContext";
import { logger } from "../../utils/logger";
import { handleChatMessage } from "../reply";

// Mock logger to suppress output during tests
jest.mock("../../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock ProjectContext
jest.mock("../../services/ProjectContext");

describe("handleChatMessage (Reply Logic)", () => {
  let mockConversationCoordinator: ReturnType<typeof mock<ConversationCoordinator>>;
  let mockAgentExecutor: ReturnType<typeof mock<AgentExecutor>>;
  let mockProjectContext: ReturnType<typeof mock<ProjectContext>>;
  let testAgent: Agent;

  beforeEach(() => {
    mockReset(logger.error); // Reset mock before each test
    mockConversationCoordinator = mock<ConversationCoordinator>();
    mockAgentExecutor = mock<AgentExecutor>();
    mockProjectContext = mock<ProjectContext>();

    testAgent = {
      pubkey: "test-agent-pubkey",
      slug: "test-agent",
      definition: { name: "Test Agent", about: "A test agent", instructions: "Be a test" },
      tools: [],
      llm: { provider: "mock", model: "mock" },
    };

    // Setup mock ProjectContext
    const agentsMap = new Map<string, Agent>([["test-agent", testAgent]]);
    Object.defineProperty(mockProjectContext, "agents", {
      get: jest.fn(() => agentsMap),
    });
    setProjectContext(mockProjectContext);

    // Mock getProjectContext to return our mock
    (getProjectContext as jest.Mock).mockReturnValue(mockProjectContext);
  });

  it("should create a new conversation for an orphaned kTag 11 reply mentioning a system agent", async () => {
    const orphanedReplyId = "orphaned-reply-id";
    const unknownConvRoot = "unknown-conv-root";
    const userPubkey = "user-pubkey";

    const orphanedReplyEvent = new NDKEvent(undefined, {
      id: orphanedReplyId,
      kind: 1112, // Using a different kind just to be clear it's not a standard chat
      content: "This is a reply to a conversation I don't know about.",
      pubkey: userPubkey,
      tags: [
        ["e", unknownConvRoot],
        ["k", "11"],
        ["p", testAgent.pubkey],
      ],
    });

    // Setup mocks
    // 1. No conversation found initially
    mockConversationCoordinator.getConversationByEvent.mockReturnValue(undefined);

    // 2. A new conversation is created
    const newConversation = new Conversation(
      new NDKEvent(undefined, { id: unknownConvRoot, content: "synthetic", pubkey: userPubkey })
    );
    mockConversationCoordinator.createConversation.mockResolvedValue(newConversation);

    // Act
    await handleChatMessage(orphanedReplyEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Assert
    // 1. It should NOT log a "No conversation found" error
    expect(logger.error).not.toHaveBeenCalledWith(
      "No conversation found for reply",
      expect.any(Object)
    );

    // 2. It should have tried to find a conversation
    expect(mockConversationCoordinator.getConversationByEvent).toHaveBeenCalledWith(
      unknownConvRoot
    );

    // 3. It should create a new conversation with a synthetic root event
    expect(mockConversationCoordinator.createConversation).toHaveBeenCalledTimes(1);
    const createConversationCallArg =
      mockConversationCoordinator.createConversation.mock.calls[0][0];
    expect(createConversationCallArg.id).toBe(unknownConvRoot);
    expect(createConversationCallArg.content).toContain(
      "[Orphaned conversation - original root not found]"
    );
    expect(createConversationCallArg.content).toContain(orphanedReplyEvent.content);

    // 4. It should add the original reply to the new conversation
    expect(mockConversationCoordinator.addEvent).toHaveBeenCalledWith(
      newConversation.id,
      orphanedReplyEvent
    );

    // 5. It should execute the agent
    expect(mockAgentExecutor.execute).toHaveBeenCalledTimes(1);
    const executionContext = mockAgentExecutor.execute.mock.calls[0][0];
    expect(executionContext.agent).toBe(testAgent);
    expect(executionContext.conversationId).toBe(newConversation.id);
    expect(executionContext.triggeringEvent).toBe(orphanedReplyEvent);
  });

  it("should NOT create a conversation for an orphaned reply NOT mentioning an agent", async () => {
    const orphanedReplyEvent = new NDKEvent(undefined, {
      kind: 1112,
      content: "This is a reply to someone else.",
      pubkey: "user-pubkey",
      tags: [
        ["e", "some-other-conv-root"],
        ["k", "11"],
        ["p", "some-other-pubkey"],
      ],
    });

    mockConversationCoordinator.getConversationByEvent.mockReturnValue(undefined);

    await handleChatMessage(orphanedReplyEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // The logic to check if the message is directed to the system runs before handleReplyLogic
    // Since it's not directed to the system, handleReplyLogic is not even called.
    expect(mockConversationCoordinator.getConversationByEvent).not.toHaveBeenCalled();
    expect(mockConversationCoordinator.createConversation).not.toHaveBeenCalled();
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
  });

  it("should log an error if conversation is not found for a standard reply", async () => {
    const standardReplyEvent = new NDKEvent(undefined, {
      kind: 1,
      content: "A standard reply",
      pubkey: "user-pubkey",
      tags: [
        ["e", "some-conv-root-that-does-not-exist"],
        ["p", mockProjectContext.pubkey],
      ],
    });

    mockConversationCoordinator.getConversationByEvent.mockReturnValue(undefined);

    await handleChatMessage(standardReplyEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    expect(logger.error).toHaveBeenCalledWith(
      "No conversation found for reply",
      expect.any(Object)
    );
    expect(mockConversationCoordinator.createConversation).not.toHaveBeenCalled();
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
  });

  it("should skip processing messages from agents to prevent self-reply loops", async () => {
    // Create an event from the project manager agent
    const pmAgent = {
      pubkey: "pm-agent-pubkey",
      slug: "project-manager",
      name: "Project Manager",
      definition: { name: "Project Manager", about: "PM", instructions: "Manage" },
      tools: [],
      llm: { provider: "mock", model: "mock" },
    };

    // Update project context with PM agent
    const agentsMap = new Map<string, Agent>([
      ["test-agent", testAgent],
      ["project-manager", pmAgent],
    ]);
    Object.defineProperty(mockProjectContext, "agents", {
      get: jest.fn(() => agentsMap),
    });

    // Also mock getAgent to return PM
    mockProjectContext.getAgent = jest.fn((slug: string) => {
      return slug === "project-manager" ? pmAgent : undefined;
    }) as any;

    // Create an event from the PM agent (kind 1111)
    const pmReplyEvent = new NDKEvent(undefined, {
      kind: 1111,
      content: "Here are your projects...",
      pubkey: pmAgent.pubkey,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    } as any);

    await handleChatMessage(pmReplyEvent, {
      conversationManager: mockConversationCoordinator,
      agentExecutor: mockAgentExecutor,
    });

    // Verify the event was skipped
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping agent's own message")
    );
    expect(mockConversationCoordinator.getConversationByEvent).not.toHaveBeenCalled();
    expect(mockConversationCoordinator.createConversation).not.toHaveBeenCalled();
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
  });
});
