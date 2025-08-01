import { mock } from "bun:test";
import path from "node:path";
import { 
    createTempDir, 
    cleanupTempDir, 
    createMockLLMService,
    createMockNDKEvent,
    type MockLLMService
} from "@/test-utils";
import { ConversationManager } from "@/conversations/ConversationManager";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { RoutingBackend } from "@/agents/execution/RoutingBackend";
import type { ExecutionContext } from "@/agents/types";
import { ConfigService } from "@/services/ConfigService";
import { EVENT_KINDS } from "@/llm/types";
import { logger } from "@/utils/logger";

export interface E2ETestContext {
    projectPath: string;
    tempDir: string;
    mockLLM: MockLLMService;
    conversationManager: ConversationManager;
    agentRegistry: AgentRegistry;
    configService: typeof ConfigService;
}

/**
 * Setup E2E test environment
 */
export async function setupE2ETest(scenarios: string[] = []): Promise<E2ETestContext> {
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
        debug: process.env.DEBUG === 'true'
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
        NostrPublisher: class {
            async publishResponse() { return Promise.resolve(); }
            async publishError() { return Promise.resolve(); }
            async publishTypingIndicator() { return Promise.resolve(); }
            async stopTypingIndicator() { return Promise.resolve(); }
        },
        getNDK: () => ({
            connect: async () => {},
            signer: { privateKey: () => "mock-private-key" }
        })
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
        },
        createExecutionLogger: () => ({
            logToolCall: () => {},
            logToolResult: () => {},
            logStream: () => {},
            logComplete: () => {},
            logError: () => {},
            logEvent: () => {}
        })
    }));
    
    // Mock tracing
    mock.module("@/tracing", () => ({
        TracingContext: class {
            constructor() {}
            getRequest() { return { id: "mock-request-id" }; }
            getConversation() { return { id: "mock-conv-id" }; }
            getAgent() { return null; }
            addConversation() {}
            addAgent() {}
            removeAgent() {}
        },
        createTracingLogger: () => ({
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {}
        })
    }));
    
    // Create test agent
    const testAgent = {
        name: "test-agent",
        slug: "test-agent",
        pubkey: "test-agent-pubkey",
        description: "Test agent for E2E tests",
        role: "Test Agent",
        instructions: "You are a test agent for E2E testing",
        systemPrompt: "You are a test agent for E2E testing",
        allowedTools: ["writeContextFile", "complete", "analyze"],
        tools: [],
        isBuiltIn: false,
        llmConfig: { model: "claude-3-sonnet-20240229", provider: "anthropic" }
    };
    
    // Mock project context to avoid complex initialization
    mock.module("@/services/ProjectContext", () => ({
        getProjectContext: () => ({
            project: { id: "test-project", pubkey: "test-pubkey" },
            signer: { privateKey: () => "test-key" },
            pubkey: "test-pubkey",
            orchestrator: null,
            agents: new Map([["test-agent", testAgent]]),
            agentLessons: new Map(),
            initialize: () => {}
        }),
        setProjectContext: () => {},
        isProjectContextInitialized: () => true
    }));
    
    // Initialize services
    const conversationManager = new ConversationManager(projectPath);
    await conversationManager.initialize();
    
    const agentRegistry = new AgentRegistry(projectPath);
    await agentRegistry.loadFromProject();
    
    // Ensure built-in agents are loaded
    const agents = agentRegistry.getAllAgents();
    if (agents.length === 0) {
        throw new Error("No agents loaded in registry");
    }
    
    return {
        projectPath,
        tempDir,
        mockLLM,
        conversationManager,
        agentRegistry,
        configService: ConfigService
    };
}

/**
 * Cleanup E2E test environment
 */
export async function cleanupE2ETest(context: E2ETestContext | undefined): Promise<void> {
    if (context?.tempDir) {
        await cleanupTempDir(context.tempDir);
    }
    mock.restore();
}

/**
 * Create and execute an agent
 */
export async function executeAgent(
    context: E2ETestContext,
    agentName: string,
    conversationId: string,
    userMessage: string,
    options: {
        onStreamContent?: (content: string) => void;
        onStreamToolCall?: (toolCall: any) => void;
        onComplete?: () => void;
        onError?: (error: Error) => void;
    } = {}
): Promise<void> {
    const agent = context.agentRegistry.getAgent(agentName);
    if (!agent) {
        throw new Error(`Agent not found: ${agentName}`);
    }
    
    const conversation = await context.conversationManager.getConversation(conversationId);
    if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
    }
    
    const executionContext: ExecutionContext = {
        agent,
        conversation,
        conversationId,
        projectPath: context.projectPath,
        userMessage,
        systemPrompt: agent.systemPrompt || "",
        availableTools: agent.allowedTools || [],
        onStreamContent: options.onStreamContent || (() => {}),
        onStreamToolCall: options.onStreamToolCall || (() => {}),
        onComplete: options.onComplete || (() => {}),
        onError: options.onError || ((error) => {
            logger.error("Agent execution error:", error);
        })
    };
    
    // Use appropriate backend based on agent
    if (agentName === "Orchestrator") {
        const backend = new RoutingBackend();
        await backend.execute(executionContext);
    } else {
        const executor = new AgentExecutor(executionContext);
        await executor.execute();
    }
}

/**
 * Create a conversation from a user message
 */
export async function createConversation(
    context: E2ETestContext,
    title: string,
    content: string,
    tags: string[][] = []
): Promise<string> {
    const event = createMockNDKEvent({
        kind: EVENT_KINDS.TASK,
        content,
        tags: [
            ["title", title],
            ...tags
        ],
        created_at: Math.floor(Date.now() / 1000)
    });
    
    const conversation = await context.conversationManager.createConversation(event);
    return conversation.id;
}

/**
 * Helper to get conversation state
 */
export async function getConversationState(
    context: E2ETestContext,
    conversationId: string
) {
    const conversation = await context.conversationManager.getConversation(conversationId);
    if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
    }
    
    return {
        phase: conversation.phase,
        phaseTransitions: conversation.phaseTransitions,
        metrics: conversation.metrics,
        agentContexts: conversation.agentContexts
    };
}

/**
 * Wait for a specific phase
 */
export async function waitForPhase(
    context: E2ETestContext,
    conversationId: string,
    expectedPhase: string,
    timeout = 5000
): Promise<void> {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
        const state = await getConversationState(context, conversationId);
        if (state.phase === expectedPhase) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error(`Timeout waiting for phase ${expectedPhase}`);
}

/**
 * Extract tool calls from mock LLM history
 */
export function getToolCallsFromHistory(mockLLM: MockLLMService): string[] {
    const history = (mockLLM as any).getRequestHistory();
    const toolCalls: string[] = [];
    
    for (const request of history) {
        if (request.response.toolCalls) {
            for (const toolCall of request.response.toolCalls) {
                toolCalls.push(toolCall.function.name);
            }
        }
    }
    
    return toolCalls;
}

/**
 * Custom assertions for E2E tests
 */
export const e2eAssertions = {
    toHavePhaseTransition(
        transitions: any[],
        from: string,
        to: string
    ): void {
        const found = transitions.some(t => t.from === from && t.to === to);
        if (!found) {
            throw new Error(`Expected phase transition from ${from} to ${to} not found`);
        }
    },
    
    toHaveToolCallSequence(
        mockLLM: MockLLMService,
        expectedSequence: string[]
    ): void {
        const actualCalls = getToolCallsFromHistory(mockLLM);
        
        // Check if expected sequence appears in order (not necessarily consecutive)
        let sequenceIndex = 0;
        for (const call of actualCalls) {
            if (call === expectedSequence[sequenceIndex]) {
                sequenceIndex++;
                if (sequenceIndex === expectedSequence.length) {
                    return; // Found complete sequence
                }
            }
        }
        
        throw new Error(
            `Expected tool sequence ${expectedSequence.join(' -> ')} not found. ` +
            `Actual calls: ${actualCalls.join(' -> ')}`
        );
    }
};