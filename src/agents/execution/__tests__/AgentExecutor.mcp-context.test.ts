import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ConversationStore } from "@/conversations/ConversationStore";
import { createMockAgent, createMockConversationStore, createMockInboundEnvelope } from "@/test-utils";
import type { MCPManager } from "@/services/mcp/MCPManager";

const mockConversationStore = createMockConversationStore({ id: "conversation-mcp-context" });
const getProjectContextMock = mock(() => ({
    project: {
        dTag: "project-1",
        tagValue: mock((name: string) => (name === "d" ? "project-1" : undefined)),
    },
}));

mock.module("@/services/projects", () => ({
    getProjectContext: getProjectContextMock,
}));

mock.module("@/conversations/executionTime", () => ({
    startExecutionTime: mock(() => undefined),
    stopExecutionTime: mock(() => undefined),
}));

mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(() => undefined),
    },
}));

mock.module("@opentelemetry/api", () => ({
    trace: {
        getActiveSpan: () => undefined,
    },
    context: {
        active: () => ({}),
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

        const { fullContext } = executor.prepareExecution(context);

        expect(fullContext.mcpManager).toBe(mcpManager);
    });
});
