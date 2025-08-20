import type { NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { getNDK } from "@/nostr";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { getProjectContext, isProjectContextInitialized } from "@/services";

// Mock dependencies
jest.mock("@/nostr");
jest.mock("@/services");
jest.mock("@/nostr/AgentPublisher");
jest.mock("@/utils/logger");

describe("AgentRegistry.republishAllAgentProfiles", () => {
  let agentRegistry: AgentRegistry;
  let mockNDK: any;
  let mockPublisher: jest.Mocked<AgentPublisher>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockNDK = {};
    (getNDK as jest.Mock).mockReturnValue(mockNDK);

    mockPublisher = {
      publishAgentProfile: jest.fn().mockResolvedValue(undefined),
      publishAgentRequest: jest.fn(),
      publishAgentCreation: jest.fn(),
    };

    (AgentPublisher as jest.Mock).mockImplementation(() => mockPublisher);

    agentRegistry = new AgentRegistry("/test/path");
  });

  it("should republish kind:0 events for all agents when project is provided", async () => {
    // Create mock project
    const mockProject: Partial<NDKProject> = {
      pubkey: "project-pubkey",
      tagValue: jest.fn().mockImplementation((tag) => {
        if (tag === "title") return "Test Project";
        return undefined;
      }),
    };

    // Create mock agents
    const mockAgent1 = {
      name: "Agent 1",
      role: "Test Role 1",
      pubkey: "agent1-pubkey",
      signer: { pubkey: "agent1-pubkey" } as NDKPrivateKeySigner,
    };

    const mockAgent2 = {
      name: "Agent 2",
      role: "Test Role 2",
      pubkey: "agent2-pubkey",
      signer: { pubkey: "agent2-pubkey" } as NDKPrivateKeySigner,
    };

    // Add agents to registry
    agentRegistry.agents.set("agent1", mockAgent1 as any);
    agentRegistry.agents.set("agent2", mockAgent2 as any);

    // Call republishAllAgentProfiles
    await agentRegistry.republishAllAgentProfiles(mockProject as NDKProject);

    // Verify AgentPublisher was created
    expect(AgentPublisher).toHaveBeenCalledWith(mockNDK);

    // Verify publishAgentProfile was called for each agent
    expect(mockPublisher.publishAgentProfile).toHaveBeenCalledTimes(2);
    expect(mockPublisher.publishAgentProfile).toHaveBeenCalledWith(
      mockAgent1.signer,
      "Agent 1",
      "Test Role 1",
      "Test Project",
      "project-pubkey"
    );
    expect(mockPublisher.publishAgentProfile).toHaveBeenCalledWith(
      mockAgent2.signer,
      "Agent 2",
      "Test Role 2",
      "Test Project",
      "project-pubkey"
    );
  });

  it("should use ProjectContext when no NDKProject is provided", async () => {
    // Mock project context
    const mockProjectContext = {
      project: {
        pubkey: "context-project-pubkey",
        tagValue: jest.fn().mockImplementation((tag) => {
          if (tag === "title") return "Context Project";
          return undefined;
        }),
      },
    };

    (isProjectContextInitialized as jest.Mock).mockReturnValue(true);
    (getProjectContext as jest.Mock).mockReturnValue(mockProjectContext);

    // Create mock agent
    const mockAgent = {
      name: "Agent 1",
      role: "Test Role",
      pubkey: "agent1-pubkey",
      signer: { pubkey: "agent1-pubkey" } as NDKPrivateKeySigner,
    };

    // Add agent to registry
    agentRegistry.agents.set("agent1", mockAgent as any);

    // Call republishAllAgentProfiles without project
    await agentRegistry.republishAllAgentProfiles();

    // Verify publishAgentProfile was called with context values
    expect(mockPublisher.publishAgentProfile).toHaveBeenCalledWith(
      mockAgent.signer,
      "Agent 1",
      "Test Role",
      "Context Project",
      "context-project-pubkey"
    );
  });

  it("should skip republishing when ProjectContext is not initialized and no project provided", async () => {
    (isProjectContextInitialized as jest.Mock).mockReturnValue(false);

    // Create mock agent
    const mockAgent = {
      name: "Agent 1",
      role: "Test Role",
      pubkey: "agent1-pubkey",
      signer: { pubkey: "agent1-pubkey" } as NDKPrivateKeySigner,
    };

    // Add agent to registry
    agentRegistry.agents.set("agent1", mockAgent as any);

    // Call republishAllAgentProfiles without project
    await agentRegistry.republishAllAgentProfiles();

    // Verify publishAgentProfile was NOT called
    expect(mockPublisher.publishAgentProfile).not.toHaveBeenCalled();
  });

  it("should continue with other agents if one fails", async () => {
    // Create mock project
    const mockProject: Partial<NDKProject> = {
      pubkey: "project-pubkey",
      tagValue: jest.fn().mockReturnValue("Test Project"),
    };

    // Create mock agents
    const mockAgent1 = {
      name: "Agent 1",
      role: "Test Role 1",
      pubkey: "agent1-pubkey",
      signer: { pubkey: "agent1-pubkey" } as NDKPrivateKeySigner,
    };

    const mockAgent2 = {
      name: "Agent 2",
      role: "Test Role 2",
      pubkey: "agent2-pubkey",
      signer: { pubkey: "agent2-pubkey" } as NDKPrivateKeySigner,
    };

    // Add agents to registry
    agentRegistry.agents.set("agent1", mockAgent1 as any);
    agentRegistry.agents.set("agent2", mockAgent2 as any);

    // Make first call fail
    mockPublisher.publishAgentProfile
      .mockRejectedValueOnce(new Error("Failed to publish"))
      .mockResolvedValueOnce(undefined);

    // Call republishAllAgentProfiles
    await agentRegistry.republishAllAgentProfiles(mockProject as NDKProject);

    // Verify both agents were attempted
    expect(mockPublisher.publishAgentProfile).toHaveBeenCalledTimes(2);
  });
});
