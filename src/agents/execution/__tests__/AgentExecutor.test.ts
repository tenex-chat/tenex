import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import { createMockLLMService } from "@/test-utils";
import type { NDK } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { AgentExecutor } from "../AgentExecutor";
import type { ExecutionContext } from "../types";

describe("AgentExecutor", () => {
  let mockLLM: ReturnType<typeof createMockLLMService>;
  let mockAgent: AgentInstance;
  let mockContext: ExecutionContext;
  let mockNDK: NDK;
  let mockConversationCoordinator: ConversationCoordinator;

  beforeEach(() => {
    // Mock required modules
    mock.module("@/services", () => ({
      getProjectContext: () => ({
        projectPath: "/test/project",
        configService: {
          getProjectPath: () => "/test/project",
        },
        project: {
          tags: [
            ["title", "Test Project"],
            ["repo", "test-repo"],
          ],
        },
        agents: new Map([
          [
            "test-agent",
            {
              id: "test-agent-id",
              name: "test-agent",
              slug: "test-agent",
              pubkey: "test-agent-pubkey",
              systemPrompt: "You are the test-agent agent",
              tools: ["shell"],
              backend: "claude",
            },
          ],
        ]),
        getLessonsForAgent: () => [],
      }),
    }));

    mock.module("@/conversations/executionTime", () => ({
      startExecutionTime: mock(() => {}),
      stopExecutionTime: mock(() => {}),
    }));

    mock.module("@/logging/ExecutionLogger", () => ({
      createExecutionLogger: () => ({
        logToolCall: () => {},
        logToolResult: () => {},
        logStream: () => {},
        logComplete: () => {},
        logError: () => {},
        logEvent: () => {},
        routingDecision: () => {},
        agentThinking: () => {},
      }),
    }));

    mock.module("@/tracing", () => ({
      createTracingContext: () => ({ id: "trace-id" }),
      createAgentExecutionContext: (parent: TracingContext, agentName: string) => ({
        id: `trace-${agentName}`,
        parent,
      }),
    }));

    mock.module("@/agents/utils", () => ({
      getAvailableTools: () => [],
      createAgentPrompt: () => "Test agent prompt",
    }));

    mock.module("@/tools/registry", () => ({
      toolRegistry: {
        getTool: (name: string) => ({
          name,
          description: `Mock ${name} tool`,
          execute: async () => ({ success: true }),
        }),
      },
    }));

    mock.module("@/prompts/utils/systemPromptBuilder", () => ({
      buildSystemPrompt: () => "You are a test agent. Help users with their tasks.",
    }));

    mock.module("@/services/mcp/MCPService", () => ({
      mcpService: {
        getAvailableTools: async () => [],
      },
    }));

    mock.module("@/nostr", () => ({
      AgentPublisher: class {
        async typing() {}
      },
    }));
    // Create mock LLM service
    mockLLM = createMockLLMService([
      {
        name: "test-agent-responses",
        description: "Test responses for AgentExecutor",
        responses: [
          {
            trigger: {
              agentName: "test-agent",
              systemPrompt: /You are the test-agent/,
            },
            response: {
              content: "I'll help you with that task.",
              toolCalls: [],
            },
            priority: 10,
          },
        ],
      },
    ]);

    // Create mock NDK
    mockNDK = {
      signer: { privateKey: () => "mock-private-key" },
      pool: { connectedRelays: () => [] },
    } as any;

    // Create mock conversation manager
    mockConversationCoordinator = {
      getConversation: mock(() => ({
        id: "test-conversation-id",
        title: "Test Conversation",
        phase: "CHAT",
        history: [],
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
      buildAgentMessages: mock(async () => ({
        messages: [{ role: "user" as const, content: "Test user message" }],
        claudeSessionId: undefined,
      })),
      buildOrchestratorRoutingContext: mock(async () => ({
        user_request: "Test user request",
        workflow_narrative:
          '=== ORCHESTRATOR ROUTING CONTEXT ===\nInitial user request: "Test user request"\n\nNo agents have been routed yet.',
      })),
      saveConversation: mock(async () => {}),
      updateState: mock(async () => {}),
      getAgentContext: mock(() => null),
      setAgentContext: mock(async () => {}),
      updatePhase: mock(async () => {}),
    } as any;

    // Create mock agent
    mockAgent = {
      id: "test-agent-id",
      name: "test-agent",
      slug: "test-agent",
      pubkey: "test-agent-pubkey",
      description: "Test agent for unit tests",
      tools: ["shell", "complete"],
      systemPrompt: "You are the test-agent agent. Help users with their tasks.",
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

    // Create mock execution context
    mockContext = {
      agent: mockAgent,
      conversationId: "test-conversation-id",
      phase: "CHAT",
      projectPath: "/test/project",
      messages: [],
      tools: [],
      toolContext: {},
      conversationCoordinator: mockConversationCoordinator,
      onStreamStart: mock(() => {}),
      onStreamToken: mock(() => {}),
      onStreamToolCall: mock(() => {}),
      onComplete: mock(() => {}),
      onError: mock((_error: Error) => {
        // Error handled in mock
      }),
    };
  });

  afterEach(() => {
    mock.restore();
  });

  describe("constructor", () => {
    it("should create an AgentExecutor instance", () => {
      const executor = new AgentExecutor(mockConversationCoordinator);
      expect(executor).toBeDefined();
    });
  });

  describe("execute", () => {
    it("should execute with claude backend", async () => {
      // Mock the backend modules
      mock.module("@/agents/execution/ClaudeBackend", () => ({
        ClaudeBackend: class {
          async execute(_messages: Message[], _tools: Tool[], context: ExecutionContext) {
            context.onStreamStart?.();
            context.onStreamToken?.("Test response");
            context.onComplete?.({
              content: "Test response",
              toolCalls: [],
            });
          }
        },
      }));

      const executor = new AgentExecutor(mockConversationCoordinator);
      await executor.execute(mockContext);

      expect(mockContext.onStreamStart).toHaveBeenCalledTimes(1);
      expect(mockContext.onStreamToken).toHaveBeenCalledWith("Test response");
      expect(mockContext.onComplete).toHaveBeenCalledWith({
        content: "Test response",
        toolCalls: [],
      });
    });

    it("should execute with reason-act backend", async () => {
      // Update agent to use reason-act backend
      mockContext.agent.backend = "reason-act";

      // Mock the backend modules
      mock.module("@/agents/execution/ReasonActLoop", () => ({
        ReasonActLoop: class {
          async execute(_messages: Message[], _tools: Tool[], context: ExecutionContext) {
            context.onStreamStart?.();
            context.onStreamToken?.("Reasoning: Test");
            context.onComplete?.({
              content: "Reasoning complete",
              toolCalls: [],
            });
          }
        },
      }));

      const executor = new AgentExecutor(mockConversationCoordinator);
      await executor.execute(mockContext);

      expect(mockContext.onStreamStart).toHaveBeenCalledTimes(1);
      expect(mockContext.onStreamToken).toHaveBeenCalledWith("Reasoning: Test");
      expect(mockContext.onComplete).toHaveBeenCalledWith({
        content: "Reasoning complete",
        toolCalls: [],
      });
    });

    it("should execute with routing backend", async () => {
      // Update agent to use routing backend
      mockContext.agent.backend = "routing";

      // Mock required modules
      mock.module("@/agents/execution/RoutingBackend", () => ({
        RoutingBackend: class {
          constructor(
            private llm: LLMService,
            private conversationCoordinator: ConversationCoordinator
          ) {}
          async execute(_messages: Message[], _tools: Tool[], context: ExecutionContext) {
            context.onStreamStart?.();
            context.onStreamToken?.("Routing to next agent");
            context.onComplete?.({
              content: "Routing complete",
              toolCalls: [],
            });
          }
        },
      }));

      const executor = new AgentExecutor(mockConversationCoordinator);
      await executor.execute(mockContext);

      expect(mockContext.onStreamStart).toHaveBeenCalledTimes(1);
      expect(mockContext.onStreamToken).toHaveBeenCalledWith("Routing to next agent");
    });

    it("should handle errors gracefully", async () => {
      const testError = new Error("Test execution error");

      // Mock backend to throw error
      mock.module("@/agents/execution/ClaudeBackend", () => ({
        ClaudeBackend: class {
          async execute() {
            throw testError;
          }
        },
      }));

      const executor = new AgentExecutor(mockConversationCoordinator);

      try {
        await executor.execute(mockContext);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBe(testError);
        // AgentExecutor no longer calls onError - it just rethrows
      }
    });

    it("should default to reason-act-loop for unknown backend", async () => {
      // Update agent with unknown backend
      (mockContext.agent as any).backend = "unknown-backend";

      // Mock ReasonActLoop for unknown backend (defaults to reason-act-loop)
      mock.module("@/agents/execution/ReasonActLoop", () => ({
        ReasonActLoop: class {
          async execute(_messages: Message[], _tools: Tool[], context: ExecutionContext) {
            context.onStreamStart?.();
            context.onStreamToken?.("Using default backend");
            context.onComplete?.({
              content: "Default backend response",
              toolCalls: [],
            });
          }
        },
      }));

      const executor = new AgentExecutor(mockConversationCoordinator);
      await executor.execute(mockContext);

      // Should use default backend successfully
      expect(mockContext.onStreamStart).toHaveBeenCalled();
      expect(mockContext.onStreamToken).toHaveBeenCalledWith("Using default backend");
    });
  });

  describe("tool loading", () => {
    it("should load tools for the agent", async () => {
      // Mock tool registry
      mock.module("@/tools/registry", () => ({
        toolRegistry: {
          getTool: (name: string) => ({
            name,
            description: `Mock ${name} tool`,
            execute: async () => ({ success: true }),
          }),
        },
      }));

      // Mock backend that checks tools
      mock.module("@/agents/execution/ClaudeBackend", () => ({
        ClaudeBackend: class {
          async execute(_messages: Message[], tools: Tool[], context: ExecutionContext) {
            expect(tools.length).toBe(1);
            expect(tools[0].name).toBe("shell");
            context.onComplete?.({
              content: "Tools loaded",
              toolCalls: [],
            });
          }
        },
      }));

      const executor = new AgentExecutor(mockConversationCoordinator);
      await executor.execute(mockContext);

      expect(mockContext.onComplete).toHaveBeenCalledWith({
        content: "Tools loaded",
        toolCalls: [],
      });
    });
  });
});
