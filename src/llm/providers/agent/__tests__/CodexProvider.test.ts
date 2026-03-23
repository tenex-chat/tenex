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

mock.module("@/utils/logger", () => ({
    logger: loggerMocks,
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
                    tenex_local_tools: {
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
        expect(Object.keys(agentSettings.mcpServers ?? {})).toContain("tenex_local_tools_2");
        expect(Object.keys(agentSettings.mcpServers ?? {})).not.toContain("tenex");

        const normalizedTenexOverride = agentSettings.configOverrides?.mcp_servers?.tenex;
        expect(normalizedTenexOverride).toBeDefined();
        expect(normalizedTenexOverride?.bearer_token).toBeUndefined();
        expect(normalizedTenexOverride?.http_headers).toEqual({
            Authorization: "Bearer secret-token",
        });

        expect(loggerMocks.warn).toHaveBeenCalled();
        expect(addEventMock).toHaveBeenCalled();
    });
});
