import { mock } from "bun:test";

/**
 * Common mock setup for services module used across many tests
 */
export function setupServicesMock(projectPath = "/test/project"): void {
    mock.module("@/services", () => ({
        getProjectContext: () => ({
            projectPath,
            configService: {
                getProjectPath: () => projectPath,
                getProject: () => ({
                    name: "test-project",
                    description: "Test project",
                    agents: []
                }),
                getMCPServices: () => []
            }
        })
    }));
}

/**
 * Common mock setup for execution time tracking
 */
export function setupExecutionTimeMock(): void {
    mock.module("@/conversations/executionTime", () => ({
        startExecutionTime: mock(() => {}),
        stopExecutionTime: mock(() => {})
    }));
}

/**
 * Common mock setup for execution logger
 */
export function setupExecutionLoggerMock(): void {
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
}

/**
 * Common mock setup for tracing
 */
export function setupTracingMock(): void {
    mock.module("@/tracing", () => ({
        createTracingContext: () => ({ id: "trace-id" }),
        createAgentExecutionContext: (parent: unknown, agentName: string) => ({ 
            id: `trace-${agentName}`,
            parent
        })
    }));
}

/**
 * Common mock setup for agent utils
 */
export function setupAgentUtilsMock(tools: unknown[] = []): void {
    mock.module("@/agents/utils", () => ({
        getAvailableTools: () => tools,
        createAgentPrompt: () => "Test agent prompt"
    }));
}

/**
 * Common mock setup for tool registry
 */
export function setupToolRegistryMock(): void {
    mock.module("@/tools/registry", () => ({
        toolRegistry: {
            getTool: (name: string) => ({
                name,
                description: `Mock ${name} tool`,
                execute: async () => ({ success: true })
            })
        }
    }));
}

/**
 * Setup all common mocks at once
 */
export function setupCommonTestMocks(projectPath = "/test/project"): void {
    setupServicesMock(projectPath);
    setupExecutionTimeMock();
    setupExecutionLoggerMock();
    setupTracingMock();
    setupAgentUtilsMock();
    setupToolRegistryMock();
}