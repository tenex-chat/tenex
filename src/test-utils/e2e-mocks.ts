import { mock } from "bun:test";
import path from "node:path";
import { createTempDir } from "@/lib/fs";
import { createMockLLMService } from "@/llm/__tests__/MockLLMService";
import { createMockNDKEvent } from "@/test-utils/mock-factories";
import type { AgentInstance } from "@/agents/types";
import type {
    MockFileSystemOperations,
    MockNDKInstance,
    MockLLMRouter,
    MockAgentPublisher,
    MockExecutionLogger,
    MockModuleSetupResult
} from "./e2e-types";

/**
 * Create mock NDK event for testing
 */
export function createE2EMockEvent(overrides: Partial<unknown> = {}): unknown {
    return createMockNDKEvent(overrides);
}

/**
 * Setup mock modules for E2E testing
 */
export async function setupMockModules(scenarios: string[] = [], defaultResponse?: string): Promise<MockModuleSetupResult> {
    // Create temp directory
    const tempDir = await createTempDir("tenex-e2e-");
    const projectPath = path.join(tempDir, "test-project");
    
    // Mock file system
    const mockFiles = new Map<string, string>();
    mockFiles.set(path.join(projectPath, "package.json"), JSON.stringify({
        name: "test-project",
        version: "1.0.0"
    }));
    
    const mockFileSystemOperations: MockFileSystemOperations = {
        fileExists: (filePath: string): boolean => mockFiles.has(filePath),
        readFile: (filePath: string): string => {
            const content = mockFiles.get(filePath);
            if (!content) throw new Error(`File not found: ${filePath}`);
            return content;
        },
        writeFile: (filePath: string, content: string): Promise<void> => {
            mockFiles.set(filePath, content);
            return Promise.resolve();
        },
        writeJsonFile: (filePath: string, data: unknown): Promise<void> => {
            mockFiles.set(filePath, JSON.stringify(data, null, 2));
            return Promise.resolve();
        },
        ensureDirectory: (): Promise<void> => Promise.resolve()
    };

    mock.module("@/lib/fs", () => ({
        fileExists: mock(mockFileSystemOperations.fileExists),
        readFile: mock(mockFileSystemOperations.readFile),
        writeFile: mock(mockFileSystemOperations.writeFile),
        writeJsonFile: mock(mockFileSystemOperations.writeJsonFile),
        ensureDirectory: mock(mockFileSystemOperations.ensureDirectory)
    }));
    
    // Initialize mock LLM
    const mockLLM = createMockLLMService(scenarios, {
        debug: process.env.DEBUG === 'true',
        defaultResponse: defaultResponse || { content: "Mock LLM: No matching response found" }
    });
    
    const createMockLLMRouterClass = (): { new(): MockLLMRouter } => {
        return class {
            getService(): unknown { 
                return mockLLM; 
            }
            validateModel(): boolean { 
                return true; 
            }
        };
    };

    mock.module("@/llm/router", () => ({
        getLLMService: () => mockLLM,
        LLMRouter: createMockLLMRouterClass()
    }));
    
    const createMockNDKInstance = (): MockNDKInstance => ({
        connect: async (): Promise<void> => {},
        signer: { privateKey: (): string => "mock-private-key" },
        pool: {
            connectedRelays: (): unknown[] => [],
            relaySet: new Set(),
            addRelay: (): void => {}
        },
        publish: async (): Promise<void> => {},
        calculateRelaySetFromEvent: (): { relays: unknown[] } => ({ relays: [] })
    });

    mock.module("@/nostr", () => ({
        getNDK: () => createMockNDKInstance()
    }));
    
    const createMockAgentPublisherClass = (): { new(): MockAgentPublisher } => {
        return class {
            async publishProfile(): Promise<void> { 
                return Promise.resolve(); 
            }
            async publishEvents(): Promise<void> { 
                return Promise.resolve(); 
            }
            async publishAgentCreation(): Promise<void> { 
                return Promise.resolve(); 
            }
        };
    };

    mock.module("@/agents/AgentPublisher", () => ({
        AgentPublisher: createMockAgentPublisherClass()
    }));
    
    
    const createMockExecutionLoggerInstance = (): MockExecutionLogger => ({
        logToolCall: (): void => {},
        logToolResult: (): void => {},
        logStream: (): void => {},
        logComplete: (): void => {},
        logError: (): void => {},
        logEvent: (): void => {},
        routingDecision: (): void => {},
        agentThinking: (): void => {}
    });

    const createMockExecutionLoggerClass = (): { new(): MockExecutionLogger } => {
        return class {
            logToolCall(): void {}
            logToolResult(): void {}
            logStream(): void {}
            logComplete(): void {}
            logError(): void {}
            logEvent(): void {}
            routingDecision(): void {}
            agentThinking(): void {}
        };
    };

    mock.module("@/logging/ExecutionLogger", () => ({
        ExecutionLogger: createMockExecutionLoggerClass(),
        createExecutionLogger: () => createMockExecutionLoggerInstance()
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