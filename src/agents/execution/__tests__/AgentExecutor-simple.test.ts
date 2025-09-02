import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";

describe("AgentExecutor - Backend Selection", () => {
  let mockAgent: AgentInstance;

  beforeEach(() => {
    // Create mock agent
    mockAgent = {
      id: "test-agent-id",
      name: "test-agent",
      slug: "test-agent",
      description: "Test agent",
      tools: [],
      systemPrompt: "You are a test agent",
      conversationStarters: [],
      customInstructions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      backend: "claude",
      projectId: "test-project",
      llmProvider: "anthropic",
      model: "claude-3-opus-20240229",
      temperature: 0.7,
    };
  });

  describe("getBackend", () => {
    it("should select claude backend", () => {
      mockAgent.backend = "claude";

      // Mock the backend modules
      mock.module("@/agents/execution/ClaudeBackend", () => ({
        ClaudeBackend: class MockClaudeBackend {
          type = "claude";
        },
      }));

      const AgentExecutor = require("../AgentExecutor").AgentExecutor;
      const executor = new AgentExecutor({});

      // Access private method via prototype
      const backend = executor.getBackend(mockAgent);
      expect(backend.type).toBe("claude");
    });

    it("should select reason-act-loop backend by default", () => {
      mockAgent.backend = undefined;

      // Mock the backend modules
      mock.module("@/agents/execution/ReasonActLoop", () => ({
        ReasonActLoop: class MockReasonActLoop {
          type = "reason-act-loop";
        },
      }));

      const AgentExecutor = require("../AgentExecutor").AgentExecutor;
      const executor = new AgentExecutor({});

      // Access private method via prototype
      const backend = executor.getBackend(mockAgent);
      expect(backend.type).toBe("reason-act-loop");
    });

    it("should select routing backend", () => {
      mockAgent.backend = "routing";

      // Mock the backend modules
      mock.module("@/agents/execution/RoutingBackend", () => ({
        RoutingBackend: class MockRoutingBackend {
          type = "routing";
        },
      }));

      const AgentExecutor = require("../AgentExecutor").AgentExecutor;
      const executor = new AgentExecutor({});

      // Access private method via prototype
      const backend = executor.getBackend(mockAgent);
      expect(backend.type).toBe("routing");
    });
  });
});
