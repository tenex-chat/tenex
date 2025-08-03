import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import path from "path";
import { createTempDir, createMockLLMService } from "@/test-utils";
import { ConversationManager } from "@/conversations/ConversationManager";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { ConfigService } from "@/services/ConfigService";
import { EVENT_KINDS } from "@/llm/types";
import type { MockResponse } from "@/test-utils/mock-llm/types";
import type { ExecutionContext } from "@/agents/execution/types";
import { NostrPublisher } from "@/nostr/NostrPublisher";
import { EventMonitor } from "@/daemon/EventMonitor";
import * as fs from "fs/promises";

describe("E2E: Complete Tool Integration", () => {
    let testDir: string;
    let projectPath: string;
    let conversationManager: ConversationManager;
    let agentRegistry: AgentRegistry;
    let mockLLM: ReturnType<typeof createMockLLMService>;
    let mockFiles: Map<string, string>;

    beforeEach(async () => {
        testDir = await createTempDir();
        projectPath = path.join(testDir, "test-project");
        
        // Mock file system
        mockFiles = new Map();
        mockFiles.set(path.join(projectPath, "package.json"), JSON.stringify({
            name: "test-project",
            version: "1.0.0"
        }));
        
        mock.module("@/lib/fs", () => ({
            fileExists: mock((filePath: string) => Promise.resolve(mockFiles.has(filePath))),
            readFile: mock((filePath: string) => {
                const content = mockFiles.get(filePath);
                if (!content) throw new Error(`File not found: ${filePath}`);
                return Promise.resolve(content);
            }),
            writeFile: mock((filePath: string, content: string) => {
                mockFiles.set(filePath, content);
                return Promise.resolve();
            }),
            ensureDirectory: mock(() => Promise.resolve()),
            writeJsonFile: mock((filePath: string, data: any) => {
                mockFiles.set(filePath, JSON.stringify(data, null, 2));
                return Promise.resolve();
            })
        }));
        
        // Create a custom scenario for complete tool testing
        const completeToolScenario: MockResponse[] = [
            {
                trigger: {
                    agentName: "Orchestrator",
                    phase: "CHAT",
                    userMessage: /analyze.*codebase/i,
                },
                response: {
                    content: "I'll help you analyze the codebase. Let me delegate this to a specialist.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: JSON.stringify({
                                summary: "User wants codebase analysis",
                                suggestedAgent: "Planner",
                                suggestedPhase: "PLAN"
                            })
                        }
                    }]
                },
                priority: 10
            },
            {
                trigger: {
                    agentName: "Planner",
                    phase: "PLAN",
                },
                response: {
                    content: "I've analyzed the requirements for codebase analysis.",
                    toolCalls: [{
                        id: "2",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                response: "Analysis complete: The codebase follows a modular architecture with clear separation of concerns.",
                                summary: "Codebase analysis completed - modular architecture identified"
                            })
                        }
                    }]
                },
                priority: 10
            },
            {
                trigger: {
                    agentName: "Orchestrator",
                    phase: "PLAN",
                    previousTools: ["complete"]
                },
                response: {
                    content: "The codebase analysis has been completed successfully. The analysis shows that your codebase follows a modular architecture with clear separation of concerns.",
                    toolCalls: []
                },
                priority: 10
            }
        ];

        mockLLM = createMockLLMService([], { customResponses: completeToolScenario });
        conversationManager = new ConversationManager(projectPath);
        agentRegistry = new AgentRegistry(projectPath);
    });

    afterEach(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
        mock.restore();
    });

    it("should handle complete tool flow from planner back to orchestrator", async () => {
        // Create initial event
        const event = {
            id: "initial-event",
            pubkey: "user-pubkey",
            content: "analyze the codebase structure",
            kind: EVENT_KINDS.TENEX_TASK,
            created_at: Date.now() / 1000,
            tags: [],
            sig: "signature"
        } as any;

        // Create conversation
        const conversation = await conversationManager.createConversation(event);
        expect(conversation.phase).toBe("CHAT");

        // Create execution context for orchestrator
        const mockPublisher = {
            publishResponse: mock(() => Promise.resolve()),
            publishTypingIndicator: mock(() => {}),
            publishTaskUpdate: mock(() => Promise.resolve()),
            publishError: mock(() => Promise.resolve()),
        } as any;

        const mockEventMonitor = {
            on: mock(() => {}),
            off: mock(() => {}),
        } as any;

        const orchestratorContext: ExecutionContext = {
            agent: agentRegistry.getAgent("Orchestrator")!,
            conversationId: conversation.id,
            conversation,
            publisher: mockPublisher,
            triggeringEvent: event,
            projectPath,
            agentRegistry,
            conversationManager,
            eventMonitor: mockEventMonitor,
            llm: mockLLM as any,
        };

        // Execute orchestrator - should delegate to planner
        const orchestratorExecutor = new AgentExecutor(orchestratorContext);
        await orchestratorExecutor.execute();

        // Verify orchestrator delegated to planner
        const history1 = mockLLM.getRequestHistory();
        expect(history1).toHaveLength(1);
        expect(history1[0].messages[0].content).toContain("analyze the codebase");
        
        // Verify phase transition
        expect(conversation.phase).toBe("PLAN");

        // Create execution context for planner
        const plannerContext: ExecutionContext = {
            agent: agentRegistry.getAgent("Planner")!,
            conversationId: conversation.id,
            conversation,
            publisher: mockPublisher,
            triggeringEvent: event,
            projectPath,
            agentRegistry,
            conversationManager,
            eventMonitor: mockEventMonitor,
            llm: mockLLM as any,
        };

        // Execute planner - should use complete tool
        const plannerExecutor = new AgentExecutor(plannerContext);
        await plannerExecutor.execute();

        // Verify planner used complete tool
        const history2 = mockLLM.getRequestHistory();
        expect(history2).toHaveLength(2);
        const plannerResponse = history2[1];
        
        // Verify the complete tool was called
        const toolCalls = plannerResponse.response.toolCalls;
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0].function.name).toBe("complete");
        
        const completeArgs = JSON.parse(toolCalls[0].function.arguments);
        expect(completeArgs.response).toContain("modular architecture");
        expect(completeArgs.summary).toContain("Codebase analysis completed");

        // Execute orchestrator again - should receive completion
        const orchestratorExecutor2 = new AgentExecutor(orchestratorContext);
        await orchestratorExecutor2.execute();

        // Verify orchestrator received and processed the completion
        const history3 = mockLLM.getRequestHistory();
        expect(history3).toHaveLength(3);
        const finalResponse = history3[2];
        expect(finalResponse.response.content).toContain("analysis has been completed successfully");
    });

    it("should handle complete tool with response only (no summary)", async () => {
        // Create a scenario where agent uses complete without summary
        const minimalCompleteScenario: MockResponse[] = [
            {
                trigger: {
                    agentName: "Executor",
                    phase: "EXECUTE",
                },
                response: {
                    content: "Task execution finished.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                response: "Successfully implemented the requested feature"
                            })
                        }
                    }]
                },
                priority: 10
            }
        ];

        const mockLLMMinimal = createMockLLMService([], { customResponses: minimalCompleteScenario });
        
        // Configure for this test
        const configService = ConfigService.getInstance();
        configService.setLLMService(mockLLMMinimal as any);

        // Create event for execution phase
        const event = {
            id: "execute-event",
            pubkey: "user-pubkey",
            content: "implement feature X",
            kind: EVENT_KINDS.TENEX_TASK,
            created_at: Date.now() / 1000,
            tags: [],
            sig: "signature"
        } as any;

        // Create conversation in EXECUTE phase
        const conversation = await conversationManager.createConversation(event);
        conversation.phase = "EXECUTE"; // Manually set phase for this test

        const mockPublisher = {
            publishResponse: mock(() => Promise.resolve()),
            publishTypingIndicator: mock(() => {}),
            publishTaskUpdate: mock(() => Promise.resolve()),
            publishError: mock(() => Promise.resolve()),
        } as any;

        const mockEventMonitor = {
            on: mock(() => {}),
            off: mock(() => {}),
        } as any;

        // Execute executor agent
        const executorContext: ExecutionContext = {
            agent: agentRegistry.getAgent("Executor")!,
            conversationId: conversation.id,
            conversation,
            publisher: mockPublisher,
            triggeringEvent: event,
            projectPath,
            agentRegistry,
            conversationManager,
            eventMonitor: mockEventMonitor,
            llm: mockLLMMinimal as any,
        };

        const executor = new AgentExecutor(executorContext);
        await executor.execute();

        // Verify complete was called without summary
        const history = mockLLMMinimal.getRequestHistory();
        expect(history).toHaveLength(1);
        const toolCalls = history[0].response.toolCalls;
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0].function.name).toBe("complete");
        
        const args = JSON.parse(toolCalls[0].function.arguments);
        expect(args.response).toBe("Successfully implemented the requested feature");
        expect(args.summary).toBeUndefined();
    });
});