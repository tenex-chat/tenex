import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ConversationStore } from "@/conversations/ConversationStore";
import { createMockAgent, createMockConversationStore, createMockInboundEnvelope } from "@/test-utils";
import type { MCPManager } from "@/services/mcp/MCPManager";
import { projectContextStore } from "@/services/projects/ProjectContextStore";

const mockConversationStore = createMockConversationStore({ id: "conversation-mcp-context" });

const testProjectContext = {
    project: {
        dTag: "project-1",
        tagValue: (name: string) => (name === "d" ? "project-1" : undefined),
    },
    agents: new Map(),
    getProjectAgentRuntimeInfo: () => [],
} as any;

mock.module("@/conversations/executionTime", () => ({
    startExecutionTime: mock(() => undefined),
    stopExecutionTime: mock(() => undefined),
}));

mock.module("@/utils/logger", () => ({
    logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        warning: () => undefined,
        error: () => undefined,
        success: () => undefined,
        isLevelEnabled: () => false,
        initDaemonLogging: async () => undefined,
        writeToWarnLog: () => undefined,
    },
}));

mock.module("@opentelemetry/api", () => ({
    trace: {
        getActiveSpan: () => undefined,
        getTracer: () => ({
            startSpan: () => ({
                end: () => undefined,
                setAttribute: () => undefined,
                setStatus: () => undefined,
                addEvent: () => undefined,
                recordException: () => undefined,
            }),
            startActiveSpan: (_name: string, fn: (span: unknown) => unknown) => fn({
                end: () => undefined,
                setAttribute: () => undefined,
                setStatus: () => undefined,
                addEvent: () => undefined,
                recordException: () => undefined,
            }),
        }),
    },
    context: {
        active: () => ({
            getValue: (_key: symbol) => undefined,
            setValue: (_key: symbol, _value: unknown) => ({ getValue: (_k: symbol) => undefined, setValue: () => ({}) as any, deleteValue: () => ({}) as any }),
            deleteValue: (_key: symbol) => ({ getValue: (_k: symbol) => undefined, setValue: () => ({}) as any, deleteValue: () => ({}) as any }),
        }),
        with: (_ctx: unknown, fn: () => unknown) => fn(),
    },
    SpanStatusCode: {
        OK: "OK",
        ERROR: "ERROR",
    },
}));

import { AgentExecutor } from "../AgentExecutor";
import type { ExecutionContext } from "../types";

describe("AgentExecutor MCP context propagation", () => {
    beforeEach(() => {
        spyOn(ConversationStore, "getOrLoad").mockReturnValue(mockConversationStore as any);
    });

    it("preserves mcpManager when building the full runtime context", () => {
        const agent = createMockAgent({
            slug: "web-researcher",
            pubkey: "b".repeat(64),
            mcpAccess: ["chrome-devtools-mcp"],
        });
        const mcpManager = {
            ensureServersForSlugs: mock(async () => undefined),
            getCachedTools: mock(() => ({})),
            getServerConfigs: mock(() => ({
                "chrome-devtools-mcp": {
                    command: "npx",
                    args: ["chrome-devtools-mcp"],
                },
            })),
        } as unknown as MCPManager;

        const context: ExecutionContext & { ralNumber: number } = {
            agent,
            conversationId: "conversation-mcp-context",
            projectBasePath: "/tmp/project",
            workingDirectory: "/tmp/project",
            currentBranch: "main",
            triggeringEnvelope: createMockInboundEnvelope(),
            getConversation: () => mockConversationStore,
            mcpManager,
            ralNumber: 1,
        };

        const executor = Object.create(AgentExecutor.prototype) as AgentExecutor & {
            publisherFactory: (agent: typeof context.agent) => unknown;
            prepareExecution: (
                runtimeContext: typeof context
            ) => { fullContext: { mcpManager?: MCPManager } };
        };
        executor.publisherFactory = () => ({});

        const { fullContext } = projectContextStore.runSync(testProjectContext, () =>
            executor.prepareExecution(context)
        );

        expect(fullContext.mcpManager).toBe(mcpManager);
    });
});
