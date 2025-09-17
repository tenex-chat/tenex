import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createAskTool } from "../ask";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
import { DelegationService } from "@/services/DelegationService";

// Mock the modules
mock.module("@/services", () => ({
  getProjectContext: mock(() => ({
    project: {
      pubkey: "ownerPubkey123",
    },
  })),
}));

mock.module("@/services/DelegationService", () => ({
  DelegationService: mock((agent, conversationId, coordinator, triggeringEvent, publisher, phase) => ({
    execute: mock(async (intent) => ({
      type: "delegation_responses",
      responses: [
        {
          response: "I choose option A",
          from: "ownerPubkey123",
        },
      ],
    })),
  })),
}));

describe("Ask Tool", () => {
  let mockContext: ExecutionContext;
  let askTool: ReturnType<typeof createAskTool>;

  beforeEach(() => {
    // Create mock context
    mockContext = {
      agent: {
        name: "TestAgent",
        slug: "test-agent",
        pubkey: "agentPubkey123",
      } as AgentInstance,
      conversationId: "conv123",
      conversationCoordinator: {} as any,
      triggeringEvent: { id: "trigger123" } as any,
      agentPublisher: {} as any,
      phase: "test-phase",
    };

    // Create the tool
    askTool = createAskTool(mockContext);
  });

  it("should have the correct metadata", () => {
    expect(askTool.description).toContain("Ask a question to the project manager");
    expect(askTool.description).toContain("wait for their response");
  });

  it("should execute an open-ended question", async () => {
    const result = await askTool.execute({
      content: "What should I name this function?",
    });

    expect(result.type).toBe("delegation_responses");
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].response).toBe("I choose option A");
    expect(result.responses[0].from).toBe("ownerPubkey123");
  });

  it("should execute a yes/no question", async () => {
    const result = await askTool.execute({
      content: "Should I proceed with the refactoring?",
      suggestions: ["Yes", "No"],
    });

    expect(result.type).toBe("delegation_responses");
    expect(result.responses).toHaveLength(1);
  });

  it("should execute a multiple choice question", async () => {
    const result = await askTool.execute({
      content: "Which approach should I use?",
      suggestions: ["Approach A", "Approach B", "Approach C"],
    });

    expect(result.type).toBe("delegation_responses");
    expect(result.responses).toHaveLength(1);
  });

  it("should generate human-readable content for open-ended questions", () => {
    const content = askTool.getHumanReadableContent({
      content: "What's the best approach?",
    });

    expect(content).toBe('Asking: "What\'s the best approach?"');
  });

  it("should generate human-readable content with suggestions", () => {
    const content = askTool.getHumanReadableContent({
      content: "Continue?",
      suggestions: ["Yes", "No"],
    });

    expect(content).toBe('Asking: "Continue?" [Yes, No]');
  });

  it("should fail when no project owner is configured", async () => {
    // Override the mock to return no project
    const { getProjectContext } = await import("@/services");
    (getProjectContext as any).mockReturnValue(null);

    // Create a new tool instance
    const toolWithoutOwner = createAskTool(mockContext);

    await expect(
      toolWithoutOwner.execute({
        content: "Test question",
      })
    ).rejects.toThrow("No project owner configured");
  });
});