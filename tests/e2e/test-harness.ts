import { mock } from "bun:test";
import path from "node:path";
import { 
    createTempDir, 
    cleanupTempDir, 
    createMockLLMService,
    createMockNDKEvent,
    type MockLLMService
} from "@/test-utils";
import { TestPersistenceAdapter } from "@/test-utils/test-persistence-adapter";
import { ConversationManager } from "@/conversations/ConversationManager";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { RoutingBackend } from "@/agents/execution/RoutingBackend";
import type { ExecutionContext } from "@/agents/execution/types";
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
    services: {
        configService: typeof ConfigService;
        projectContext: any;
    };
    projectConfig: any;
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
            warning: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {}
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
            project: { 
                id: "test-project", 
                pubkey: "test-pubkey",
                tagValue: (tag: string) => tag === "title" ? "Test Project" : null,
                tags: [["title", "Test Project"]]
            },
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
    
    // Initialize services with test persistence adapter
    const testPersistenceAdapter = new TestPersistenceAdapter();
    const conversationManager = new ConversationManager(projectPath, testPersistenceAdapter);
    await conversationManager.initialize();
    
    const agentRegistry = new AgentRegistry(projectPath);
    await agentRegistry.loadFromProject();
    
    // Ensure built-in agents are loaded
    const agents = agentRegistry.getAllAgents();
    if (agents.length === 0) {
        console.error("Warning: No agents loaded in registry");
    }
    
    // Get orchestrator for testing
    const orchestrator = agentRegistry.getAgent("Orchestrator") || agentRegistry.getAgent("orchestrator");
    if (!orchestrator) {
        console.error("Available agents:", agents.map(a => a.name));
    }
    
    return {
        projectPath,
        tempDir,
        mockLLM,
        conversationManager,
        agentRegistry,
        configService: ConfigService,
        services: {
            configService: ConfigService,
            projectContext: null
        },
        projectConfig: {
            title: "Test Project",
            hashtags: ["test"],
            identifier: "test-project"
        }
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
    // Try both the provided name and lowercase version
    const agent = context.agentRegistry.getAgent(agentName) || 
                  context.agentRegistry.getAgent(agentName.toLowerCase());
    if (!agent) {
        console.error("Available agents:", context.agentRegistry.getAllAgents().map(a => ({ slug: a.slug, name: a.name })));
        throw new Error(`Agent not found: ${agentName}`);
    }
    
    const conversation = await context.conversationManager.getConversation(conversationId);
    if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
    }
    
    // Create a mock NDK event for the triggering event
    const triggeringEvent = createMockNDKEvent({
        kind: EVENT_KINDS.TASK,
        content: userMessage,
        created_at: Math.floor(Date.now() / 1000)
    });
    
    // Create mock publisher
    const mockPublisher = {
        publishResponse: async () => {},
        publishError: async () => {},
        publishTypingIndicator: async () => {},
        stopTypingIndicator: async () => {}
    };
    
    // Create AgentExecutor first for use in ExecutionContext
    let agentExecutor: AgentExecutor | undefined;
    
    const executionContext: ExecutionContext = {
        agent,
        conversationId,
        phase: conversation.phase,
        projectPath: context.projectPath,
        triggeringEvent,
        publisher: mockPublisher as any,
        conversationManager: context.conversationManager,
        previousPhase: conversation.previousPhase,
        handoff: conversation.phaseTransitions[conversation.phaseTransitions.length - 1],
        claudeSessionId: undefined,
        agentExecutor: undefined, // Will be set below
        tracingContext: {
            requestId: "test-request-" + Math.random().toString(36).substr(2, 9),
            conversationId,
            getRequest: () => ({ id: "test-request" }),
            getConversation: () => ({ id: conversationId }),
            getAgent: () => agent
        } as any
    };
    
    // Create AgentExecutor with the context
    agentExecutor = new AgentExecutor({
        agent,
        conversation,
        conversationId,
        projectPath: context.projectPath,
        userMessage,
        systemPrompt: agent.systemPrompt || "",
        availableTools: agent.allowedTools || [],
        llmService: context.mockLLM,
        tracingContext: {
            requestId: "test-request-" + Math.random().toString(36).substr(2, 9),
            conversationId,
            getRequest: () => ({ id: "test-request" }),
            getConversation: () => ({ id: conversationId }),
            getAgent: () => agent
        },
        onStreamContent: options.onStreamContent || (() => {}),
        onStreamToolCall: options.onStreamToolCall || (() => {}),
        onComplete: options.onComplete || (() => {}),
        onError: options.onError || ((error) => {
            logger.error("Agent execution error:", error);
        })
    });
    
    // Set the agentExecutor in the context
    executionContext.agentExecutor = agentExecutor;
    
    // Use appropriate backend based on agent
    if (agentName.toLowerCase() === "orchestrator") {
        const backend = new RoutingBackend(context.mockLLM, context.conversationManager);
        await backend.execute([], [], executionContext, mockPublisher as any);
    } else {
        await agentExecutor.execute();
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