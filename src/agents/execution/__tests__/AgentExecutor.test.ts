import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { AgentExecutor } from "../AgentExecutor";
import { createMockLLMService, MockFactory } from "@/test-utils";
import type { ExecutionContext } from "../types";
import type { AgentInstance } from "@/agents/types";
import { Message } from "multi-llm-ts";
import type { ConversationManager } from "@/conversations/ConversationManager";
import { NDK } from "@nostr-dev-kit/ndk";

describe("AgentExecutor", () => {
    let mockLLM: ReturnType<typeof createMockLLMService>;
    let mockAgent: AgentInstance;
    let mockContext: ExecutionContext;
    let mockNDK: NDK;
    let mockConversationManager: ConversationManager;
    
    beforeEach(() => {
        // Mock required modules
        mock.module("@/services", () => ({
            getProjectContext: () => ({
                projectPath: "/test/project",
                configService: {
                    getProjectPath: () => "/test/project"
                },
                project: {
                    tags: [
                        ["title", "Test Project"],
                        ["repo", "test-repo"]
                    ]
                },
                agents: new Map([
                    ["test-agent", {
                        id: "test-agent-id",
                        name: "test-agent",
                        slug: "test-agent",
                        pubkey: "test-agent-pubkey",
                        systemPrompt: "You are the test-agent agent",
                        tools: ["analyze", "complete"],
                        backend: "claude"
                    }]
                ]),
                getLessonsForAgent: () => []
            })
        }));
        
        mock.module("@/conversations/executionTime", () => ({
            startExecutionTime: mock(() => {}),
            stopExecutionTime: mock(() => {})
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
                agentThinking: () => {}
            })
        }));
        
        mock.module("@/tracing", () => ({
            createTracingContext: () => ({ id: "trace-id" }),
            createAgentExecutionContext: (parent: any, agentName: string) => ({ 
                id: `trace-${agentName}`,
                parent
            })
        }));
        
        mock.module("@/agents/utils", () => ({
            getAvailableTools: () => [],
            createAgentPrompt: () => "Test agent prompt"
        }));
        
        mock.module("@/tools/registry", () => ({
            toolRegistry: {
                getTool: (name: string) => ({
                    name,
                    description: `Mock ${name} tool`,
                    execute: async () => ({ success: true })
                })
            }
        }));
        
        mock.module("@/prompts/utils/systemPromptBuilder", () => ({
            buildSystemPrompt: () => "You are a test agent. Help users with their tasks."
        }));
        
        mock.module("@/services/mcp/MCPService", () => ({
            mcpService: {
                getAvailableTools: async () => []
            }
        }));
        
        mock.module("@/nostr", () => ({
            NostrPublisher: class {
                constructor() {}
                async publishTypingIndicator() {}
                async publishResponse() {}
                cleanup() {}
            }
        }));
        // Create mock LLM service
        mockLLM = createMockLLMService([{
            name: "test-agent-responses",
            description: "Test responses for AgentExecutor",
            responses: [
                {
                    trigger: {
                        agentName: "test-agent",
                        systemPrompt: /You are the test-agent/
                    },
                    response: {
                        content: "I'll help you with that task.",
                        toolCalls: []
                    },
                    priority: 10
                }
            ]
        }]);
        
        // Create mock NDK
        mockNDK = {
            signer: { privateKey: () => "mock-private-key" },
            pool: { connectedRelays: () => [] }
        } as any;
        
        // Create mock conversation manager
        mockConversationManager = {
            getConversation: mock(() => ({
                id: "test-conversation-id",
                title: "Test Conversation",
                phase: "CHAT",
                history: [],
                agentStates: new Map(),
                phaseStartedAt: Date.now(),
                metadata: {},
                phaseTransitions: [],
                orchestratorTurns: [],
                executionTime: {
                    totalSeconds: 0,
                    isActive: false,
                    lastUpdated: Date.now()
                }
            })),
            buildAgentMessages: mock(async () => ({
                messages: [
                    new Message("user", "Test user message")
                ],
                claudeSessionId: undefined
            })),
            buildOrchestratorRoutingContext: mock(async () => ({
                user_request: "Test user request",
                routing_history: [],
                current_routing: null
            })),
            saveConversation: mock(async () => {}),
            updateState: mock(async () => {}),
            getAgentContext: mock(() => null),
            setAgentContext: mock(async () => {}),
            updatePhase: mock(async () => {})
        } as any;
        
        // Create mock agent
        mockAgent = {
            id: "test-agent-id",
            name: "test-agent",
            slug: "test-agent",
            pubkey: "test-agent-pubkey",
            description: "Test agent for unit tests",
            tools: ["analyze", "complete"],
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
            isOrchestrator: false
        };
        
        // Create mock publisher
        const mockPublisher = {
            publishTypingIndicator: mock(async () => {}),
            publishResponse: mock(async () => {}),
            cleanup: mock(() => {})
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
            conversationManager: mockConversationManager,
            publisher: mockPublisher as any,
            onStreamStart: mock(() => {}),
            onStreamToken: mock(() => {}),
            onStreamToolCall: mock(() => {}),
            onComplete: mock(() => {}),
            onError: mock((error: Error) => {
                // Error handled in mock
            })
        };
    });
    
    afterEach(() => {
        mock.restore();
    });
    
    describe("constructor", () => {
        it("should create an AgentExecutor instance", () => {
            const executor = new AgentExecutor(mockLLM, mockNDK, mockConversationManager);
            expect(executor).toBeDefined();
        });
    });
    
    describe("execute", () => {
        it("should execute with claude backend", async () => {
            // Mock the backend modules
            mock.module("@/agents/execution/ClaudeBackend", () => ({
                ClaudeBackend: class {
                    async execute(messages: Message[], tools: any[], context: ExecutionContext) {
                        context.onStreamStart?.();
                        context.onStreamToken?.("Test response");
                        context.onComplete?.({
                            content: "Test response",
                            toolCalls: []
                        });
                    }
                }
            }));
            
            const executor = new AgentExecutor(mockLLM, mockNDK, mockConversationManager);
            await executor.execute(mockContext);
            
            expect(mockContext.onStreamStart).toHaveBeenCalledTimes(1);
            expect(mockContext.onStreamToken).toHaveBeenCalledWith("Test response");
            expect(mockContext.onComplete).toHaveBeenCalledWith({
                content: "Test response",
                toolCalls: []
            });
        });
        
        it("should execute with reason-act backend", async () => {
            // Update agent to use reason-act backend
            mockContext.agent.backend = "reason-act";
            
            // Mock the backend modules
            mock.module("@/agents/execution/ReasonActLoop", () => ({
                ReasonActLoop: class {
                    async execute(messages: Message[], tools: any[], context: ExecutionContext) {
                        context.onStreamStart?.();
                        context.onStreamToken?.("Reasoning: Test");
                        context.onComplete?.({
                            content: "Reasoning complete",
                            toolCalls: []
                        });
                    }
                }
            }));
            
            const executor = new AgentExecutor(mockLLM, mockNDK, mockConversationManager);
            await executor.execute(mockContext);
            
            expect(mockContext.onStreamStart).toHaveBeenCalledTimes(1);
            expect(mockContext.onStreamToken).toHaveBeenCalledWith("Reasoning: Test");
            expect(mockContext.onComplete).toHaveBeenCalledWith({
                content: "Reasoning complete",
                toolCalls: []
            });
        });
        
        it("should execute with routing backend", async () => {
            // Update agent to use routing backend
            mockContext.agent.backend = "routing";
            
            // Mock required modules
            mock.module("@/agents/execution/RoutingBackend", () => ({
                RoutingBackend: class {
                    constructor(private llm: any, private conversationManager: any) {}
                    async execute(messages: Message[], tools: any[], context: ExecutionContext) {
                        context.onStreamStart?.();
                        context.onStreamToken?.("Routing to next agent");
                        context.onComplete?.({
                            content: "Routing complete",
                            toolCalls: []
                        });
                    }
                }
            }));
            
            const executor = new AgentExecutor(mockLLM, mockNDK, mockConversationManager);
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
                }
            }));
            
            const executor = new AgentExecutor(mockLLM, mockNDK, mockConversationManager);
            
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
                    async execute(messages: Message[], tools: any[], context: ExecutionContext) {
                        context.onStreamStart?.();
                        context.onStreamToken?.("Using default backend");
                        context.onComplete?.({
                            content: "Default backend response",
                            toolCalls: []
                        });
                    }
                }
            }));
            
            const executor = new AgentExecutor(mockLLM, mockNDK, mockConversationManager);
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
                        execute: async () => ({ success: true })
                    })
                }
            }));
            
            // Mock backend that checks tools
            mock.module("@/agents/execution/ClaudeBackend", () => ({
                ClaudeBackend: class {
                    async execute(messages: Message[], tools: any[], context: ExecutionContext) {
                        expect(tools.length).toBe(2);
                        expect(tools[0].name).toBe("analyze");
                        expect(tools[1].name).toBe("complete");
                        context.onComplete?.({
                            content: "Tools loaded",
                            toolCalls: []
                        });
                    }
                }
            }));
            
            const executor = new AgentExecutor(mockLLM, mockNDK, mockConversationManager);
            await executor.execute(mockContext);
            
            expect(mockContext.onComplete).toHaveBeenCalledWith({
                content: "Tools loaded",
                toolCalls: []
            });
        });
    });
});