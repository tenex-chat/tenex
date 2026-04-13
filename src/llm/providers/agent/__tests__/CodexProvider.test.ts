import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AISdkTool } from "@/tools/types";

const createCodexAppServerMock = mock(() => mock(() => ({
    specificationVersion: "v2",
    provider: "codex-app-server",
    modelId: "mock-model",
    supportsUrl: () => false,
    doGenerate: mock(async () => ({})),
    doStream: mock(async () => ({ stream: new ReadableStream() })),
})));

mock.module("ai-sdk-provider-codex-cli", () => ({
    createCodexAppServer: createCodexAppServerMock,
    createLocalMcpServer: async (args: { name: string; tools: unknown[] }) => ({
        config: {
            transport: "http",
            url: `http://127.0.0.1/${args.name}`,
            bearerToken: "test-token",
        },
        url: `http://127.0.0.1/${args.name}`,
        port: 8080,
        stop: async () => undefined,
    }),
    tool: (config: {
        name: string;
        description: string;
        parameters: unknown;
        execute: unknown;
    }) => config,
}));

const loggerMocks = {
    warn: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {}),
};
const queueReminderMock = mock(() => {});

mock.module("@/utils/logger", () => ({
    logger: loggerMocks,
}));

mock.module("@/llm/system-reminder-context", () => ({
    getSystemReminderContext: () => ({
        queue: queueReminderMock,
    }),
}));

const addEventMock = mock(() => {});
const mockSpan = {
    addEvent: addEventMock,
    setAttribute: mock(() => {}),
    setAttributes: mock(() => {}),
    setStatus: mock(() => {}),
    end: mock(() => {}),
    isRecording: () => true,
    recordException: mock(() => {}),
    updateName: mock(() => {}),
    spanContext: () => ({ traceId: "test", spanId: "test", traceFlags: 0 }),
};
const mockContext = {
    getValue: () => undefined,
    setValue: () => mockContext,
    deleteValue: () => mockContext,
};

mock.module("@opentelemetry/api", () => ({
    createContextKey: mock((name: string) => Symbol.for(name)),
    DiagLogLevel: {
        NONE: 0,
        ERROR: 1,
        WARN: 2,
        INFO: 3,
        DEBUG: 4,
        VERBOSE: 5,
        ALL: 6,
    },
    diag: {
        setLogger: mock(() => {}),
        debug: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        info: mock(() => {}),
    },
    SpanKind: {
        INTERNAL: 0,
        SERVER: 1,
        CLIENT: 2,
        PRODUCER: 3,
        CONSUMER: 4,
    },
    SpanStatusCode: { ERROR: 2, OK: 1 },
    TraceFlags: { NONE: 0, SAMPLED: 1 },
    ROOT_CONTEXT: mockContext,
    trace: {
        getActiveSpan: () => mockSpan,
        getTracer: () => ({
            startSpan: () => mockSpan,
            startActiveSpan: (_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan),
        }),
    },
    context: {
        active: () => mockContext,
        with: (_ctx: typeof mockContext, fn: () => unknown) => fn(),
    },
}));

import { CodexProvider } from "../CodexProvider";

describe("CodexProvider", () => {
    const mockTool: AISdkTool = {
        description: "Test tool",
        inputSchema: {},
        execute: async () => ({ ok: true }),
    };

    beforeEach(() => {
        createCodexAppServerMock.mockClear();
        loggerMocks.warn.mockClear();
        loggerMocks.error.mockClear();
        loggerMocks.info.mockClear();
        loggerMocks.debug.mockClear();
        addEventMock.mockClear();
        queueReminderMock.mockClear();
    });

    it("avoids internal MCP server name collisions and normalizes legacy bearer_token overrides", async () => {
        const provider = new CodexProvider();
        await provider.initialize({});

        const result = provider.createModel("gpt-5.4", {
            agentName: "Test Agent",
            tools: {
                fs_read: mockTool,
            },
            mcpConfig: {
                enabled: true,
                servers: {
                    tenex: {
                        command: "node",
                        args: ["server.js"],
                    },
                },
            },
            providerConfig: {
                configOverrides: {
                    mcp_servers: {
                        tenex: {
                            url: "https://example.com/mcp",
                            bearer_token: "secret-token",
                        },
                    },
                },
            },
        });

        const agentSettings = result.agentSettings as {
            mcpServers?: Record<string, unknown>;
            configOverrides?: {
                mcp_servers?: Record<string, Record<string, unknown>>;
            };
        };

        expect(agentSettings.mcpServers).toBeDefined();
        expect(Object.keys(agentSettings.mcpServers ?? {})).toContain("tenex_2");
        expect(Object.keys(agentSettings.mcpServers ?? {})).toContain("tenex");

        const normalizedTenexOverride = agentSettings.configOverrides?.mcp_servers?.tenex;
        expect(normalizedTenexOverride).toBeDefined();
        expect(normalizedTenexOverride?.bearer_token).toBeUndefined();
        expect(normalizedTenexOverride?.http_headers).toEqual({
            Authorization: "Bearer secret-token",
        });

        expect(loggerMocks.warn).toHaveBeenCalled();
        expect(addEventMock).toHaveBeenCalled();
    });

    it("rejects native exec approvals and injects TENEX tool guidance by default", async () => {
        const provider = new CodexProvider();
        await provider.initialize({});

        const result = provider.createModel("gpt-5.4", {
            agentName: "Test Agent",
            providerConfig: {},
        });

        const agentSettings = result.agentSettings as {
            approvalPolicy?: string;
            developerInstructions?: string;
            serverRequests?: {
                onCommandExecutionApproval?: (request: {
                    id: string;
                    method: string;
                    params: {
                        threadId: string;
                        turnId: string;
                        itemId: string;
                        command?: string | null;
                    };
                }) => Promise<{ decision: string } | undefined>;
                onFileChangeApproval?: (request: {
                    id: string;
                    method: string;
                    params: {
                        threadId: string;
                        turnId: string;
                        itemId: string;
                        reason?: string | null;
                        grantRoot?: string | null;
                    };
                }) => Promise<{ decision: string } | undefined>;
                onSkillApproval?: (request: {
                    id: string;
                    method: string;
                    params: {
                        itemId: string;
                        skillName: string;
                    };
                }) => Promise<{ decision: string } | undefined>;
            };
            onSessionCreated?: (session: {
                threadId: string;
                injectMessage: (content: string) => Promise<void>;
            }) => Promise<void>;
        };

        expect((agentSettings as { baseInstructions?: string }).baseInstructions).toContain(
            "Prefer TENEX tools over native Codex actions in TENEX."
        );
        expect(agentSettings.developerInstructions).toBeUndefined();
        expect(agentSettings.approvalPolicy).toBe("on-request");
        expect(agentSettings.serverRequests?.onCommandExecutionApproval).toBeDefined();
        expect(agentSettings.serverRequests?.onFileChangeApproval).toBeDefined();
        expect(agentSettings.serverRequests?.onSkillApproval).toBeDefined();

        const injectMessageMock = mock(async () => undefined);
        await agentSettings.onSessionCreated?.({
            threadId: "thread-1",
            injectMessage: injectMessageMock,
        });

        const response = await agentSettings.serverRequests?.onCommandExecutionApproval?.({
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "item-1",
                command: "playwright-cli",
            },
        });

        const fileResponse = await agentSettings.serverRequests?.onFileChangeApproval?.({
            id: "approval-2",
            method: "item/fileChange/requestApproval",
            params: {
                threadId: "thread-1",
                turnId: "turn-2",
                itemId: "item-2",
                reason: "apply patch",
                grantRoot: "/tmp/project",
            },
        });

        const skillResponse = await agentSettings.serverRequests?.onSkillApproval?.({
            id: "approval-3",
            method: "skill/requestApproval",
            params: {
                itemId: "item-3",
                skillName: "browser-debugging",
            },
        });

        expect(response).toEqual({ decision: "decline" });
        expect(fileResponse).toEqual({ decision: "decline" });
        expect(skillResponse).toEqual({ decision: "decline" });
        expect(injectMessageMock).toHaveBeenCalledTimes(3);
        expect(String(injectMessageMock.mock.calls[0]?.[0])).toContain(
            "Retry with the TENEX `shell` tool instead"
        );
        expect(String(injectMessageMock.mock.calls[1]?.[0])).toContain(
            "TENEX filesystem tools"
        );
        expect(String(injectMessageMock.mock.calls[2]?.[0])).toContain(
            "Codex-native skills"
        );
        expect(queueReminderMock).toHaveBeenCalledTimes(3);
    });

    it("puts TENEX routing guidance in baseInstructions while passing custom developer instructions through", async () => {
        const provider = new CodexProvider();
        await provider.initialize({});

        const result = provider.createModel("gpt-5.4", {
            agentName: "Test Agent",
            providerConfig: {
                developerInstructions: "Custom instructions",
            },
        });

        const agentSettings = result.agentSettings as {
            approvalPolicy?: string;
            developerInstructions?: string;
            baseInstructions?: string;
            serverRequests?: Record<string, unknown>;
        };

        expect(agentSettings.approvalPolicy).toBe("on-request");
        // TENEX tool routing goes to baseInstructions so developerInstructions
        // can be used by the library to pass through the system prompt messages.
        expect(agentSettings.baseInstructions).toContain(
            "Prefer TENEX tools over native Codex actions in TENEX."
        );
        // Custom developerInstructions pass through as-is (not merged with routing guidance).
        expect(agentSettings.developerInstructions).toBe("Custom instructions");
        expect(agentSettings.serverRequests).toBeDefined();
    });

    it("overrides explicit approval policies when TENEX tool routing is enabled", async () => {
        const provider = new CodexProvider();
        await provider.initialize({});

        const result = provider.createModel("gpt-5.4", {
            agentName: "Test Agent",
            providerConfig: {
                approvalPolicy: "never",
            },
        });

        const agentSettings = result.agentSettings as {
            approvalPolicy?: string;
        };

        expect(agentSettings.approvalPolicy).toBe("on-request");
        expect(loggerMocks.warn).toHaveBeenCalled();
    });
});
