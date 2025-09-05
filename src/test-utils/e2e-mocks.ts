import { mock } from "bun:test";
import path from "node:path";
import { createTempDir } from "@/lib/fs";
import { createMockLLMService } from "@/llm/__tests__/MockLLMService";
import { createMockNDKEvent } from "@/test-utils/mock-factories";
import type { AgentInstance } from "@/agents/types";
import type { E2ETestContext } from "./e2e-types";

/**
 * Create mock NDK event for testing
 */
export function createE2EMockEvent(overrides: Partial<any> = {}): any {
    return createMockNDKEvent(overrides);
}

/**
 * Setup mock modules for E2E testing
 */
export async function setupMockModules(scenarios: string[] = [], defaultResponse?: string): Promise<{
    tempDir: string;
    projectPath: string;
    mockLLM: any;
    mockFiles: Map<string, string>;
}> {
    // Create temp directory
    const tempDir = await createTempDir("tenex-e2e-");
    const projectPath = path.join(tempDir, "test-project");
    
    // Mock file system
    const mockFiles = new Map<string, string>();
    mockFiles.set(path.join(projectPath, "package.json"), JSON.stringify({
        name: "test-project",
        version: "1.0.0"
    }));
    
    mock.module("@/lib/fs", () => ({
        fileExists: mock((filePath: string) => mockFiles.has(filePath)),
        readFile: mock((filePath: string) => {
            const content = mockFiles.get(filePath);
            if (!content) throw new Error(`File not found: ${filePath}`);
            return content;
        }),
        writeFile: mock((filePath: string, content: string) => {
            mockFiles.set(filePath, content);
            return Promise.resolve();
        }),
        writeJsonFile: mock((filePath: string, data: any) => {
            mockFiles.set(filePath, JSON.stringify(data, null, 2));
            return Promise.resolve();
        }),
        ensureDirectory: mock(() => Promise.resolve())
    }));
    
    // Initialize mock LLM
    const mockLLM = createMockLLMService(scenarios, {
        debug: process.env.DEBUG === 'true',
        defaultResponse: defaultResponse || { content: "Mock LLM: No matching response found" }
    });
    
    // Mock LLM router
    mock.module("@/llm/router", () => ({
        getLLMService: () => mockLLM,
        LLMRouter: class {
            constructor() {}
            getService() { return mockLLM; }
            validateModel() { return true; }
        }
    }));
    
    // Mock Nostr publisher
    mock.module("@/nostr", () => ({
        getNDK: () => ({
            connect: async () => {},
            signer: { privateKey: () => "mock-private-key" },
            pool: {
                connectedRelays: () => [],
                relaySet: new Set(),
                addRelay: () => {}
            },
            publish: async () => {},
            calculateRelaySetFromEvent: () => ({ relays: [] })
        })
    }));
    
    // Mock AgentPublisher to prevent publishing during tests
    mock.module("@/agents/AgentPublisher", () => ({
        AgentPublisher: class {
            async publishProfile() { return Promise.resolve(); }
            async publishEvents() { return Promise.resolve(); }
            async publishAgentCreation() { return Promise.resolve(); }
        }
    }));
    
    // Mock ClaudeBackend to prevent launching actual Claude Code process
    mock.module("@/agents/execution/ClaudeBackend", () => ({
        ClaudeBackend: class {
            async execute(messages: any[], tools: any[], context: any, publisher: any) {
                // Use the mock LLM instead of launching Claude Code
                const response = await mockLLM.complete({
                    messages,
                    options: {
                        configName: context.agent.llmConfig || context.agent.name,
                        agentName: context.agent.name
                    }
                });
                
                // Simulate Claude Code execution
                // 1. Publish the response content
                if (response.content) {
                    await publisher.publishResponse(response.content, null, false);
                }
                
                // 2. Handle tool calls if present
                if (response.toolCalls && response.toolCalls.length > 0) {
                    for (const toolCall of response.toolCalls) {
                        // Add tool handlers as needed
                        // toolCall.function.name and toolCall.function.arguments are available if needed
                    }
                }
                
                return Promise.resolve();
            }
        }
    }));
    
    // Mock logging
    mock.module("@/logging/ExecutionLogger", () => ({
        ExecutionLogger: class {
            logToolCall() {}
            logToolResult() {}
            logStream() {}
            logComplete() {}
            logError() {}
            logEvent() {}
            routingDecision() {}
            agentThinking() {}
        },
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
    
    return { tempDir, projectPath, mockLLM, mockFiles };
}

/**
 * Create test agents for E2E tests
 */
export function createTestAgents(): AgentInstance[] {
    const pmAgent = {
        name: "test-pm",
        slug: "test-pm",
        pubkey: "test-pm-pubkey",
        eventId: "test-pm-event-id",
        description: "Test PM agent for E2E tests",
        role: "Project Manager",
        instructions: "You are a test PM agent for E2E testing",
        systemPrompt: "You are a test PM agent for E2E testing",
        allowedTools: ["delegate_phase", "writeContextFile", "analyze"],
        tools: [],
        llmConfig: { model: "claude-3-sonnet-20240229", provider: "anthropic" }
    };
    
    const executorAgent = {
        name: "executor",
        slug: "executor",
        pubkey: "executor-pubkey",
        eventId: "executor-event-id",
        description: "Executor agent for E2E tests",
        role: "Executor",
        instructions: "You are an executor agent for E2E testing",
        systemPrompt: "You are an executor agent for E2E testing",
        allowedTools: ["shell", "writeContextFile"],
        tools: [],
        llmConfig: { model: "claude-3-sonnet-20240229", provider: "anthropic" }
    };
    
    const plannerAgent = {
        name: "planner",
        slug: "planner",
        pubkey: "planner-pubkey",
        eventId: "planner-event-id",
        description: "Planner agent for E2E tests",
        role: "Planner",
        instructions: "You are a planner agent for E2E testing",
        systemPrompt: "You are a planner agent for E2E testing",
        allowedTools: ["analyze"],
        tools: [],
        llmConfig: { model: "claude-3-sonnet-20240229", provider: "anthropic" }
    };
    
    return [pmAgent as AgentInstance, executorAgent as AgentInstance, plannerAgent as AgentInstance];
}