import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { ConversationMessageRepository } from "@/conversations/ConversationMessageRepository";
import type { MockLLMService } from "@/llm/__tests__/MockLLMService";
import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { ProjectContext } from "@/services/ProjectContext";

export interface E2ETestContext {
    mockLLM: MockLLMService;
    conversationCoordinator: ConversationCoordinator;
    messageRepo: ConversationMessageRepository;
    agentRegistry: AgentRegistry;
    projectContext: ProjectContext;
    testAgents: AgentInstance[];
    cleanup: () => Promise<void>;
}

export interface ExecutionTrace {
    conversationId: string;
    executions: AgentExecutionRecord[];
    toolCalls: ToolCallRecord[];
    routingDecisions: RoutingDecision[];
    agentInteractions: AgentExecutionRecord[];
}

export interface AgentExecutionRecord {
    agent: string;
    phase: string;
    timestamp: Date;
    message?: string;
    toolCalls?: ToolCall[];
}


export interface ToolCallRecord {
    agent: string;
    tool: string;
    arguments: Record<string, unknown>;
    timestamp: Date;
}

export interface ToolCall {
    id?: string;
    type?: string;
    function?: {
        name: string;
        arguments: string;
    };
    name?: string;
    params?: Record<string, unknown>;
}

export interface AgentExecutionResult {
    message: string;
    toolCalls: ToolCall[];
}

export interface RoutingDecision {
    agents: string[];
    phase?: string;
    reason: string;
}

export interface MockFileSystemOperations {
    fileExists: (filePath: string) => boolean;
    readFile: (filePath: string) => string;
    writeFile: (filePath: string, content: string) => Promise<void>;
    writeJsonFile: (filePath: string, data: unknown) => Promise<void>;
    ensureDirectory: () => Promise<void>;
}

export interface MockNDKInstance {
    connect: () => Promise<void>;
    signer: { privateKey: () => string };
    pool: {
        connectedRelays: () => unknown[];
        relaySet: Set<unknown>;
        addRelay: () => void;
    };
    publish: () => Promise<void>;
    calculateRelaySetFromEvent: () => { relays: unknown[] };
}

export interface MockLLMRouter {
    getService: () => unknown;
    validateModel: () => boolean;
}

export interface MockAgentPublisher {
    publishProfile: () => Promise<void>;
    publishEvents: () => Promise<void>;
    publishAgentCreation: () => Promise<void>;
}

export interface MockExecutionLogger {
    logToolCall: () => void;
    logToolResult: () => void;
    logStream: () => void;
    logComplete: () => void;
    logError: () => void;
    logEvent: () => void;
    routingDecision: () => void;
    agentThinking: () => void;
}

export interface MockModuleSetupResult {
    tempDir: string;
    projectPath: string;
    mockLLM: unknown;
    mockFiles: Map<string, string>;
}

export interface ProjectTagAccessor {
    (tag: string): string | null;
}

export interface SignerPrivateKeyAccessor {
    (): string;
}

export interface ProjectOwnershipChecker {
    (): boolean;
}

export interface ProjectManagerAccessor {
    (): AgentInstance;
}

export interface PhaseSpecialistChecker {
    (phase: string): boolean;
}

export interface PhaseSpecialistAccessor {
    (phase: string): AgentInstance | null;
}

export interface AgentIdentifierResolver {
    (identifier: string): AgentInstance | null;
}

export interface TestEnvironmentCleanupResult {
    mocksRestored: boolean;
    databaseClosed: boolean;
    tempDirectoryRemoved: boolean;
    errors?: Error[];
}