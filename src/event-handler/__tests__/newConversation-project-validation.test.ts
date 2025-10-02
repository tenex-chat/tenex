import { describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";
import { handleNewConversation } from "../newConversation";

// Mock the logger
mock.module("@/utils/logger", () => ({
  logger: {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

describe("handleNewConversation - Project Context Validation", () => {
  it("should route kind 11 to global agent when project context matches", async () => {
    // Create a mock global agent
    const globalAgent: Partial<AgentInstance> = {
      name: "GlobalAgent",
      pubkey: "global-agent-pubkey",
      isGlobal: true,
      slug: "global-agent",
    };

    // Mock project context with the global agent
    const mockProjectContext = {
      agents: new Map([["global-agent", globalAgent as AgentInstance]]),
      getAgentByPubkey: (pubkey: string) => {
        if (pubkey === "global-agent-pubkey") return globalAgent as AgentInstance;
        return undefined;
      },
      project: {
        tagValue: (tag: string) => tag === "d" ? "project-123" : undefined,
      } as any,
    };

    // Mock conversation coordinator
    const mockConversationCoordinator = {
      createConversation: mock(async (event: NDKEvent) => ({
        id: "conversation-123",
        title: "Test",
        phase: "CHAT",
        history: [event],
        agentStates: new Map(),
        phaseStartedAt: Date.now(),
        metadata: {},
        executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
      })),
      getConversation: mock(() => ({})),
    };

    // Mock agent executor
    const mockAgentExecutor = {
      execute: mock(async () => {}),
    };

    // Mock getProjectContext
    mock.module("@/services", () => ({
      getProjectContext: () => mockProjectContext,
    }));

    // Create kind 11 event with matching project context
    const event: Partial<NDKEvent> = {
      kind: 11,
      content: "Hello",
      tags: [
        ["p", "global-agent-pubkey"],
        ["a", "31933:some-pubkey:project-123"], // Matching project
      ],
      pubkey: "user-pubkey",
    };

    await handleNewConversation(event as NDKEvent, {
      conversationCoordinator: mockConversationCoordinator as any,
      agentExecutor: mockAgentExecutor as any,
    });

    // Should have executed with the global agent
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: globalAgent,
        conversationId: "conversation-123",
      })
    );
  });

  it("should NOT route kind 11 to global agent when project context does not match", async () => {
    // Create a mock global agent
    const globalAgent: Partial<AgentInstance> = {
      name: "GlobalAgent",
      pubkey: "global-agent-pubkey",
      isGlobal: true,
      slug: "global-agent",
    };

    // Mock project context with the global agent
    const mockProjectContext = {
      agents: new Map([["global-agent", globalAgent as AgentInstance]]),
      getAgentByPubkey: (pubkey: string) => {
        if (pubkey === "global-agent-pubkey") return globalAgent as AgentInstance;
        return undefined;
      },
      project: {
        tagValue: (tag: string) => tag === "d" ? "project-123" : undefined,
      } as any,
    };

    // Mock conversation coordinator
    const mockConversationCoordinator = {
      createConversation: mock(async (event: NDKEvent) => ({
        id: "conversation-456",
        title: "Test",
        phase: "CHAT",
        history: [event],
        agentStates: new Map(),
        phaseStartedAt: Date.now(),
        metadata: {},
        executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
      })),
      getConversation: mock(() => ({})),
    };

    // Mock agent executor
    const mockAgentExecutor = {
      execute: mock(async () => {}),
    };

    // Mock getProjectContext
    mock.module("@/services", () => ({
      getProjectContext: () => mockProjectContext,
    }));

    // Create kind 11 event with DIFFERENT project context
    const event: Partial<NDKEvent> = {
      kind: 11,
      content: "Hello",
      tags: [
        ["p", "global-agent-pubkey"],
        ["a", "31933:some-pubkey:project-456"], // Different project!
      ],
      pubkey: "user-pubkey",
    };

    await handleNewConversation(event as NDKEvent, {
      conversationCoordinator: mockConversationCoordinator as any,
      agentExecutor: mockAgentExecutor as any,
    });

    // Should NOT have executed with any agent
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
  });

  it("should route kind 11 to local agent regardless of project context", async () => {
    // Create a mock local (non-global) agent
    const localAgent: Partial<AgentInstance> = {
      name: "LocalAgent",
      pubkey: "local-agent-pubkey",
      isGlobal: false, // Not a global agent
      slug: "local-agent",
    };

    // Mock project context with the local agent
    const mockProjectContext = {
      agents: new Map([["local-agent", localAgent as AgentInstance]]),
      getAgentByPubkey: (pubkey: string) => {
        if (pubkey === "local-agent-pubkey") return localAgent as AgentInstance;
        return undefined;
      },
      project: {
        tagValue: (tag: string) => tag === "d" ? "project-123" : undefined,
      } as any,
    };

    // Mock conversation coordinator
    const mockConversationCoordinator = {
      createConversation: mock(async (event: NDKEvent) => ({
        id: "conversation-789",
        title: "Test",
        phase: "CHAT",
        history: [event],
        agentStates: new Map(),
        phaseStartedAt: Date.now(),
        metadata: {},
        executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
      })),
      getConversation: mock(() => ({})),
    };

    // Mock agent executor
    const mockAgentExecutor = {
      execute: mock(async () => {}),
    };

    // Mock getProjectContext
    mock.module("@/services", () => ({
      getProjectContext: () => mockProjectContext,
    }));

    // Create kind 11 event with different project context
    const event: Partial<NDKEvent> = {
      kind: 11,
      content: "Hello",
      tags: [
        ["p", "local-agent-pubkey"],
        ["a", "31933:some-pubkey:project-456"], // Different project - doesn't matter for local agents
      ],
      pubkey: "user-pubkey",
    };

    await handleNewConversation(event as NDKEvent, {
      conversationCoordinator: mockConversationCoordinator as any,
      agentExecutor: mockAgentExecutor as any,
    });

    // Should have executed with the local agent (project context ignored for local agents)
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: localAgent,
        conversationId: "conversation-789",
      })
    );
  });

  it("should allow kind 11 to global agent when event has no project reference (backward compatibility)", async () => {
    // Create a mock global agent
    const globalAgent: Partial<AgentInstance> = {
      name: "GlobalAgent",
      pubkey: "global-agent-pubkey",
      isGlobal: true,
      slug: "global-agent",
    };

    // Mock project context with the global agent
    const mockProjectContext = {
      agents: new Map([["global-agent", globalAgent as AgentInstance]]),
      getAgentByPubkey: (pubkey: string) => {
        if (pubkey === "global-agent-pubkey") return globalAgent as AgentInstance;
        return undefined;
      },
      project: {
        tagValue: (tag: string) => tag === "d" ? "project-123" : undefined,
      } as any,
    };

    // Mock conversation coordinator
    const mockConversationCoordinator = {
      createConversation: mock(async (event: NDKEvent) => ({
        id: "conversation-999",
        title: "Test",
        phase: "CHAT",
        history: [event],
        agentStates: new Map(),
        phaseStartedAt: Date.now(),
        metadata: {},
        executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
      })),
      getConversation: mock(() => ({})),
    };

    // Mock agent executor
    const mockAgentExecutor = {
      execute: mock(async () => {}),
    };

    // Mock getProjectContext
    mock.module("@/services", () => ({
      getProjectContext: () => mockProjectContext,
    }));

    // Create kind 11 event WITHOUT a project reference
    const event: Partial<NDKEvent> = {
      kind: 11,
      content: "Hello",
      tags: [
        ["p", "global-agent-pubkey"],
        // No "a" tag
      ],
      pubkey: "user-pubkey",
    };

    await handleNewConversation(event as NDKEvent, {
      conversationCoordinator: mockConversationCoordinator as any,
      agentExecutor: mockAgentExecutor as any,
    });

    // Should have executed with the global agent (backward compatibility)
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: globalAgent,
        conversationId: "conversation-999",
      })
    );
  });
});
