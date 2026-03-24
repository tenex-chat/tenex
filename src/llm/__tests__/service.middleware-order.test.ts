import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LanguageModel, ProviderRegistryProvider } from "ai";

const mockDevToolsMiddleware = mock(() => ({ specificationVersion: "v3" as const }));

mock.module("@ai-sdk/devtools", () => ({
    devToolsMiddleware: mockDevToolsMiddleware,
}));

const addEvent = mock(() => {});
const end = mock(() => {});
const setAttributes = mock(() => {});
const mockSpan = {
    addEvent,
    end,
    setAttributes,
    setAttribute: mock(() => {}),
    setStatus: mock(() => {}),
    isRecording: () => true,
    recordException: mock(() => {}),
    updateName: mock(() => {}),
    spanContext: () => ({ traceId: "test-trace", spanId: "test-span", traceFlags: 1 }),
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
    ROOT_CONTEXT: mockContext,
    trace: {
        getActiveSpan: () => mockSpan,
        getTracer: () => ({
            startSpan: () => mockSpan,
            startActiveSpan: (_name: string, fn: (span: typeof mockSpan) => unknown) =>
                fn(mockSpan),
        }),
        setSpan: () => mockContext,
    },
    SpanStatusCode: { ERROR: 2, OK: 1 },
    TraceFlags: { NONE: 0, SAMPLED: 1 },
    context: {
        active: () => mockContext,
        with: (_ctx: unknown, fn: () => unknown) => fn(),
    },
}));

import { LLMService, type StandardProviderAccessor } from "../service";
import { getSystemReminderContext } from "../system-reminder-context";
import type { ProviderCapabilities } from "../providers/types";

const mockCapabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    builtInTools: false,
    requiresApiKey: true,
    mcpSupport: false,
};

function createMockRegistry(
    capturedDoStream: ReturnType<typeof mock>
): ProviderRegistryProvider {
    const mockModel: LanguageModel = {
        specificationVersion: "v3",
        provider: "test-provider",
        modelId: "test-model",
        supportedUrls: {},
        doGenerate: mock(async () => ({
            content: [{ type: "text", text: "Mock response" }],
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 20 },
        })),
        doStream: capturedDoStream as unknown as LanguageModel["doStream"],
    } as unknown as LanguageModel;

    return {
        languageModel: mock(() => mockModel),
        textEmbeddingModel: mock(() => ({})),
        imageModel: mock(() => ({})),
    } as unknown as ProviderRegistryProvider;
}

function createMockAccessor(registry: ProviderRegistryProvider): StandardProviderAccessor {
    return () => ({ registry, activeApiKey: "test-key" });
}

describe("LLMService middleware ordering", () => {
    beforeEach(() => {
        mockDevToolsMiddleware.mockClear();
        addEvent.mockClear();
        end.mockClear();
        setAttributes.mockClear();
        getSystemReminderContext().clear();
    });

    test("final-request trace observes the fully mutated provider prompt in the service middleware chain", async () => {
        const capturedDoStream = mock(async (params: Record<string, unknown>) => ({
            stream: new ReadableStream(),
            request: { body: params },
        }));
        const service = new LLMService(
            createMockAccessor(createMockRegistry(capturedDoStream)),
            "openrouter",
            "gpt-4",
            mockCapabilities
        );

        getSystemReminderContext().queue({
            type: "heuristic",
            content: "Service-level reminder.",
        });

        const model = service.getModel();
        await model.doStream({
            prompt: [
                { role: "user", content: [] },
                {
                    role: "user",
                    content: [{ type: "text", text: "Keep this message" }],
                },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Trailing assistant" }],
                },
            ],
        } as any);

        const finalRequestEvent = addEvent.mock.calls.find(
            ([name]) => name === "llm.final_request.captured"
        )?.[1] as Record<string, unknown> | undefined;
        const finalPrompt = JSON.parse(String(finalRequestEvent?.["llm.final_prompt_json"]));
        const capturedPrompt = capturedDoStream.mock.calls[0]?.[0]?.prompt;

        expect(finalRequestEvent).toBeDefined();
        expect(finalPrompt).toEqual(capturedPrompt);
        expect(JSON.stringify(finalPrompt)).toContain("Service-level reminder.");
        expect(JSON.stringify(finalPrompt)).toContain("<heuristic>");
        expect(finalPrompt).toHaveLength(1);
        expect(finalPrompt[0]).toEqual({
            role: "user",
            content: [
                {
                    type: "text",
                    text: expect.stringContaining("Keep this message"),
                },
            ],
        });
        expect(setAttributes).toHaveBeenCalledWith({
            "llm.request_type": "stream",
            "llm.final_message_count": 1,
            "llm.final_has_provider_options": false,
            "llm.final_has_tool_choice": false,
        });
    });
});
