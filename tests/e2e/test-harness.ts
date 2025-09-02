import { mock, expect } from "bun:test";
import path from "node:path";
import { 
    createTempDir, 
    cleanupTempDir, 
    createMockLLMService,
    createMockNDKEvent,
    type MockLLMService
} from "@/test-utils";
import { TestPersistenceAdapter } from "@/test-utils/test-persistence-adapter";
import { ConversationCoordinator } from "@/conversations";
import { AgentRegistry } from "@/agents/AgentRegistry";
import type { ToolCall } from "@/llm/types";
import type { ModelMessage as Message } from "ai";
import { ConfigService } from "@/services/ConfigService";
import { EVENT_KINDS } from "@/llm/types";
import type { ProjectContext } from "@/services/project/ProjectContext";
import type { TenexConfig } from "@/services/config/types";

export interface E2ETestContext {
    projectPath: string;
    tempDir: string;
    mockLLM: MockLLMService;
    conversationCoordinator: ConversationCoordinator;
    agentRegistry: AgentRegistry;
    configService: typeof ConfigService;
    services: {
        configService: typeof ConfigService;
        projectContext: ProjectContext;
    };
    projectConfig: TenexConfig;
}

// Execution trace for tracking conversation flow
export interface ExecutionTrace {
    conversationId: string;
    executions: AgentExecutionRecord[];
    phaseTransitions: PhaseTransitionRecord[];
    toolCalls: ToolCallRecord[];
    routingDecisions: RoutingDecisionRecord[];
}

export interface AgentExecutionRecord {
    agent: string;
    phase: string;
    timestamp: Date;
    message?: string;
    toolCalls?: ToolCallRecord[];
}

export interface PhaseTransitionRecord {
    from: string;
    to: string;
    agent: string;
    reason: string;
    timestamp: Date;
}

export interface ToolCallRecord {
    agent: string;
    tool: string;
    arguments: Record<string, unknown>;
    timestamp: Date;
}

export interface RoutingDecisionRecord {
    fromAgent: string;
    toAgents: string[];
    phase: string;
    reason: string;
    timestamp: Date;
}

/**
 * Setup E2E test environment
 */
export async function setupE2ETest(scenarios: string[] = [], defaultResponse?: string): Promise<E2ETestContext> {
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
                        const toolName = toolCall.function.name;
                        const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                        // Add tool handlers as needed
                    }
                }
                
                return Promise.resolve();
            }
        }
    }))
    
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
    
    // Create test agents - first one becomes PM
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
    
    // Mock project context with dynamic PM (first agent)
    const agentsMap = new Map([
        ["test-pm", pmAgent],      // First agent becomes PM
        ["executor", executorAgent],
        ["planner", plannerAgent]
    ]);
    
    const mockProjectContext = {
        project: { 
            id: "test-project", 
            pubkey: "test-pubkey",
            tagValue: (tag: string) => tag === "title" ? "Test Project" : null,
            tags: [
                ["title", "Test Project"],
                ["agent", "test-pm-event-id"],    // First agent tag - becomes PM
                ["agent", "executor-event-id"],
                ["agent", "planner-event-id"]
            ]
        },
        signer: { privateKey: () => "test-key" },
        pubkey: "test-pubkey",
        orchestrator: null,
        agents: agentsMap,
        agentLessons: new Map(),
        projectManager: pmAgent,  // Set the PM
        getProjectManager: () => pmAgent,  // Dynamic PM getter
        getAgent: (slug: string) => agentsMap.get(slug),
        initialize: () => {},
        getLessonsForAgent: () => []
    };
    
    mock.module("@/services/ProjectContext", () => ({
        getProjectContext: () => mockProjectContext,
        setProjectContext: async () => {},
        isProjectContextInitialized: () => true
    }));
    
    // Initialize services with test persistence adapter
    const testPersistenceAdapter = new TestPersistenceAdapter();
    const conversationCoordinator = new ConversationCoordinator(projectPath, testPersistenceAdapter);
    await conversationCoordinator.initialize();
    
    const agentRegistry = new AgentRegistry(projectPath);
    await agentRegistry.loadFromProject();
    
    // Verify agents are loaded  
    const agents = agentRegistry.getAllAgents();
    if (agents.length === 0) {
        console.error("Warning: No agents loaded in registry");
    }
    
    // Get orchestrator for testing
    const orchestrator = agentRegistry.getAgent("Orchestrator") || agentRegistry.getAgent("orchestrator");
    if (!orchestrator) {
        console.error("Available agents:", agents.map(a => a.name));
    }
    
    // Store mockLLM in global context for ClaudeBackend mock
    // Removed unnecessary global storage - mockLLM is already accessible via context
    
    return {
        projectPath,
        tempDir,
        mockLLM,
        conversationCoordinator,
        agentRegistry,
        configService: ConfigService,
        projectContext: mockProjectContext,  // Add project context
        services: {
            configService: ConfigService,
            projectContext: mockProjectContext
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
 * Create a mock publisher for testing
 */
function createMockPublisher() {
    return {
        publishResponse: async () => {},
        publishError: async () => {},
        publishTypingIndicator: async () => {},
        stopTypingIndicator: async () => {},
        cleanup: () => {}
    };
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
    
    const conversation = await context.conversationCoordinator.createConversation(event);
    return conversation.id;
}

/**
 * Helper to get conversation state
 */
export async function getConversationState(
    context: E2ETestContext,
    conversationId: string
) {
    const conversation = await context.conversationCoordinator.getConversation(conversationId);
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

/**
 * Execute a complete conversation flow, automatically following orchestrator routing
 */
export async function executeConversationFlow(
    context: E2ETestContext,
    conversationId: string,
    initialMessage: string,
    options?: {
        maxIterations?: number;
        onAgentExecution?: (agent: string, phase: string) => void;
        onPhaseTransition?: (from: string, to: string) => void;
    }
): Promise<ExecutionTrace> {
    const maxIterations = options?.maxIterations || 20;
    let iteration = 0;
    
    const trace: ExecutionTrace = {
        conversationId,
        executions: [],
        phaseTransitions: [],
        toolCalls: [],
        routingDecisions: []
    };
    
    // Track conversation state
    let currentMessage = initialMessage;
    let lastAgentExecuted: string | null = null;
    
    while (iteration < maxIterations) {
        iteration++;
        
        // Get current conversation state
        const state = await getConversationState(context, conversationId);
        const currentPhase = state.phase;
        
        // Always execute orchestrator for routing
        const orchestratorResult = await executeAgentWithResult(
            context,
            "orchestrator",
            conversationId,
            iteration === 1 ? currentMessage : ""
        );
        
        // Record orchestrator execution
        trace.executions.push({
            agent: "orchestrator",
            phase: currentPhase,
            timestamp: new Date(),
            message: orchestratorResult.message
        });
        
        // Extract routing decision from orchestrator response
        const routingDecision = extractRoutingDecision(orchestratorResult);
        if (!routingDecision) {
            // No routing decision means conversation is complete
            console.log("No routing decision found. Orchestrator result:", orchestratorResult.message);
            break;
        }
        
        // Record routing decision
        trace.routingDecisions.push({
            fromAgent: "orchestrator",
            toAgents: routingDecision.agents,
            phase: routingDecision.phase || currentPhase,
            reason: routingDecision.reason,
            timestamp: new Date()
        });
        
        // Update conversation phase if specified in routing decision
        if (routingDecision.phase && routingDecision.phase !== currentPhase) {
            await context.conversationCoordinator.updatePhase(
                conversationId,
                routingDecision.phase as any,
                routingDecision.reason,
                "orchestrator-pubkey",
                "orchestrator",
                routingDecision.reason
            );
        }
        
        // Execute each target agent
        for (const targetAgent of routingDecision.agents) {
            if (targetAgent === "END") {
                // Conversation complete
                return trace;
            }
            
            // Notify callback
            if (options?.onAgentExecution) {
                options.onAgentExecution(targetAgent, routingDecision.phase || currentPhase);
            }
            
            // Execute target agent
            const agentResult = await executeAgentWithResult(
                context,
                targetAgent,
                conversationId,
                "" // No message, agent gets context from conversation
            );
            
            // Record agent execution
            trace.executions.push({
                agent: targetAgent,
                phase: routingDecision.phase || currentPhase,
                timestamp: new Date(),
                message: agentResult.message,
                toolCalls: agentResult.toolCalls
            });
            
            // Record tool calls
            if (agentResult.toolCalls) {
                for (const toolCall of agentResult.toolCalls) {
                    // Handle different tool call structures
                    let toolName: string;
                    let toolArgs: any;
                    
                    if (toolCall.function) {
                        // Standard OpenAI-style structure
                        toolName = toolCall.function.name;
                        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } else if (toolCall.name) {
                        // Simplified structure from our mock
                        toolName = toolCall.name;
                        toolArgs = toolCall.params || {};
                    } else {
                        console.warn('Unknown tool call structure:', toolCall);
                        continue;
                    }
                    
                    trace.toolCalls.push({
                        agent: targetAgent,
                        tool: toolName,
                        arguments: toolArgs,
                        timestamp: new Date()
                    });
                    
                    // Check for continue tool - means we need to go back to orchestrator
                    if (toolName === 'continue') {
                        lastAgentExecuted = targetAgent;
                        // Update mock LLM context for next iteration
                        if ((context.mockLLM as any).updateContext) {
                            (context.mockLLM as any).updateContext({
                                lastContinueCaller: targetAgent,
                                iteration: iteration,
                            });
                        }
                    }
                        
                        // End conversation in specific scenarios:
                        // 1. If certain phases are completed
                        // 2. If workflow is complete
                        // Check if PM agent (first agent in project) completed certain phases
                        const pmAgent = context.projectContext.getProjectManager();
                        const isPMAgent = targetAgent === pmAgent.slug;
                        
                        if (targetAgent === 'orchestrator' || 
                            (isPMAgent && 
                             (routingDecision.phase === 'verification' || routingDecision.phase === 'plan'))) {
                            return trace;
                        }
                    }
                }
            }
            
            // Check for phase transitions
            const newState = await getConversationState(context, conversationId);
            if (newState.phase !== currentPhase) {
                trace.phaseTransitions.push({
                    from: currentPhase,
                    to: newState.phase,
                    agent: targetAgent,
                    reason: routingDecision.reason,
                    timestamp: new Date()
                });
                
                if (options?.onPhaseTransition) {
                    options.onPhaseTransition(currentPhase, newState.phase);
                }
            }
        }
    }
    
    return trace;
}

interface AgentExecutionResult {
    message: string;
    toolCalls: ToolCall[];
}

/**
 * Execute agent and return result (internal helper)
 */
async function executeAgentWithResult(
    context: E2ETestContext,
    agentName: string,
    conversationId: string,
    userMessage: string
): Promise<AgentExecutionResult> {
    const result: AgentExecutionResult = {
        message: "",
        toolCalls: []
    };
    
    // Try both the provided name and lowercase version
    const agent = context.agentRegistry.getAgent(agentName) || 
                  context.agentRegistry.getAgent(agentName.toLowerCase());
    if (!agent) {
        console.error("Available agents:", context.agentRegistry.getAllAgents().map(a => ({ slug: a.slug, name: a.name })));
        throw new Error(`Agent not found: ${agentName}`);
    }
    
    const conversation = await context.conversationCoordinator.getConversation(conversationId);
    if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
    }
    
    // Use appropriate backend based on agent
    if (agentName.toLowerCase() === "orchestrator") {
        // For orchestrator, we need to get the routing decision without executing agents
        // Build a simple orchestrator message
        const orchestratorMessages = [
            new Message("system", `You are the orchestrator. Current phase: ${conversation.phase}. You must respond with ONLY a JSON object in this exact format:
{
    "agents": ["agent-slug"],
    "phase": "phase-name",
    "reason": "Your reasoning here"
}

No other text, only valid JSON.`)
        ];
        
        // Add user message if provided
        if (userMessage) {
            orchestratorMessages.push(new Message("user", userMessage));
        }
        
        // Use the mock LLM directly to get routing decision
        const response = await context.mockLLM.complete({
            messages: orchestratorMessages,
            options: {
                configName: agent.llmConfig || "orchestrator",
                agentName: agent.name
            }
        });
        
        // Stream the response
        if (response.content) {
            result.message = response.content;
        }
    } else {
        // Execute non-orchestrator agents directly with mock LLM
        // Build simple agent messages
        const agentMessages = [
            new Message("system", `You are the ${agent.slug || agent.name} agent. Current Phase: ${conversation.phase}.`),
        ];
        
        if (userMessage) {
            agentMessages.push(new Message("user", userMessage));
        }
        
        // Get response from mock LLM
        const response = await context.mockLLM.complete({
            messages: agentMessages,
            options: {
                configName: agent.llmConfig || agent.name,
                agentName: agent.name
            }
        });
        
        // Stream the response
        if (response.content) {
            result.message = response.content;
        }
        
        // Process tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
            result.toolCalls = response.toolCalls.map(tc => ({
                id: tc.name || 'mock-tool-call',
                type: 'function' as const,
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.params || {})
                }
            }));
        }
    }
    
    // Result is already logged by the conversational logger in MockLLMService
    
    return result;
}

interface RoutingDecision {
    agents: string[];
    phase?: string;
    reason: string;
}

/**
 * Extract routing decision from orchestrator response
 */
function extractRoutingDecision(orchestratorResult: AgentExecutionResult): RoutingDecision | null {
    try {
        // Orchestrator with routing backend returns JSON
        const content = orchestratorResult.message;
        if (!content) return null;
        
        // Try to parse as JSON
        const parsed = JSON.parse(content);
        if (parsed.agents && Array.isArray(parsed.agents)) {
            return parsed;
        }
    } catch (_e) {
        // Not a routing decision
    }
    return null;
}

// Assertion helpers for traces
export function assertAgentSequence(trace: ExecutionTrace, ...expectedAgents: string[]) {
    const executedAgents = trace.executions.map(e => e.agent);
    expect(executedAgents).toEqual(expectedAgents);
}

export function assertPhaseTransitions(trace: ExecutionTrace, ...expectedPhases: string[]) {
    const phases = trace.phaseTransitions.map(t => t.to);
    expect(phases).toEqual(expectedPhases);
}

export function assertToolCalls(trace: ExecutionTrace, agent: string, ...expectedTools: string[]) {
    const agentTools = trace.toolCalls
        .filter(tc => tc.agent === agent)
        .map(tc => tc.tool);
    expect(agentTools).toEqual(expectedTools);
}

export function assertFeedbackPropagated(trace: ExecutionTrace, fromAgent: string, toAgent: string, keyword: string): boolean {
    // Find message from fromAgent
    const fromExecution = trace.executions.find(e => 
        e.agent === fromAgent && e.message?.includes(keyword)
    );
    if (!fromExecution) return false;
    
    // Find subsequent execution of toAgent
    const fromIndex = trace.executions.indexOf(fromExecution);
    const toExecution = trace.executions
        .slice(fromIndex + 1)
        .find(e => e.agent === toAgent);
    
    return toExecution !== undefined;
}

export { createMockNDKEvent };