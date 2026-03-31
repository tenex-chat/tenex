import { describe, test, expect, beforeEach, beforeAll, afterAll, mock } from "bun:test";
import type { LanguageModel, ModelMessage, ProviderRegistryProvider } from "ai";
import { createFinishHandler } from "../FinishHandler";
import { LLMService, type StandardProviderAccessor, type KeyRotationHandler } from "../service";
import type { ProviderCapabilities } from "../providers/types";

/**
 * Default mock capabilities for standard providers (no built-in tools)
 */
const mockCapabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    builtInTools: false,
    requiresApiKey: true,
    mcpSupport: false,
};

/**
 * Mock capabilities for agent providers (with built-in tools)
 */
const mockAgentCapabilities: ProviderCapabilities = {
    ...mockCapabilities,
    builtInTools: true,
    requiresApiKey: false,
    mcpSupport: true,
};

/** Creates an async generator that immediately throws the given error on first iteration */
function throwingStream(error: unknown): AsyncGenerator<never> {
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next(): Promise<IteratorResult<never>> {
            throw error;
        },
        async return(): Promise<IteratorResult<never>> {
            return { done: true, value: undefined as never };
        },
        async throw(e: unknown): Promise<IteratorResult<never>> {
            throw e;
        },
    };
}

// Mock the AI SDK functions
const mockStreamText = mock(() => ({
    textStream: (async function* () {
        yield "Hello";
        yield ", ";
        yield "world!";
    })(),
    fullStream: (async function* () {
        yield { type: "text-delta", textDelta: "Hello" };
        yield { type: "text-delta", textDelta: ", " };
        yield { type: "text-delta", textDelta: "world!" };
        yield { type: "finish", finishReason: "stop" };
    })(),
}));

const mockGenerateObject = mock(() =>
    Promise.resolve({
        object: { result: "test" },
        usage: { inputTokens: 5, outputTokens: 10 },
    })
);

const mockGenerateText = mock(() =>
    Promise.resolve({
        text: "mock text",
        usage: { inputTokens: 5, outputTokens: 10 },
    })
);

mock.module("ai", () => ({
    streamText: mockStreamText,
    generateObject: mockGenerateObject,
    generateText: mockGenerateText,
    smoothStream: mock(() => ({})),
    wrapLanguageModel: mock((config: { model: LanguageModel }) => config.model),
    extractReasoningMiddleware: mock(() => ({})),
}));

// Mock OpenTelemetry - must be comprehensive to avoid polluting other tests
const mockSpan = {
    addEvent: mock(() => {}),
    setAttribute: mock(() => {}),
    setStatus: mock(() => {}),
    end: mock(() => {}),
    isRecording: () => true,
    recordException: mock(() => {}),
    updateName: mock(() => {}),
    setAttributes: mock(() => {}),
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
    ROOT_CONTEXT: mockContext,
    trace: {
        getActiveSpan: () => mockSpan,
        getTracer: () => ({
            startSpan: () => mockSpan,
            startActiveSpan: (_name: string, fn: (span: typeof mockSpan) => any) => fn(mockSpan),
        }),
        setSpan: () => mockContext,
    },
    SpanStatusCode: { ERROR: 2, OK: 1 },
    TraceFlags: { NONE: 0, SAMPLED: 1 },
    context: {
        active: () => mockContext,
        with: (_ctx: any, fn: () => any) => fn(),
    },
}));

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        debug: mock(() => {}),
        writeToWarnLog: mock(() => {}),
    },
}));

// Mock ProgressMonitor
mock.module("@/agents/execution/ProgressMonitor", () => ({
    ProgressMonitor: class {
        check() {
            return Promise.resolve(true);
        }
    },
}));

const originalFetch = global.fetch;
const mockFetch = mock(() =>
    Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
    })
);

beforeAll(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
    global.fetch = originalFetch;
});

/**
 * Create a mock provider registry for testing
 */
function createMockRegistry(): ProviderRegistryProvider {
    const mockModel: LanguageModel = {
        specificationVersion: "v2",
        provider: "test-provider",
        modelId: "test-model",
        supportsUrl: () => false,
        doGenerate: mock(() =>
            Promise.resolve({
                content: [{ type: "text", text: "Mock response" }],
                finishReason: "stop",
                usage: { inputTokens: 10, outputTokens: 20 },
            })
        ),
        doStream: mock(() =>
            Promise.resolve({
                stream: new ReadableStream(),
            })
        ),
    } as unknown as LanguageModel;

    return {
        languageModel: mock(() => mockModel),
        textEmbeddingModel: mock(() => ({})),
        imageModel: mock(() => ({})),
    } as unknown as ProviderRegistryProvider;
}

/**
 * Create a mock agent provider function.
 */
function createMockAgentProvider(provider = "codex") {
    return mock(() => ({
        specificationVersion: "v2",
        provider,
        modelId: `${provider}-model`,
        supportsUrl: () => false,
        doGenerate: mock(() => Promise.resolve({})),
        doStream: mock(() => Promise.resolve({ stream: new ReadableStream() })),
    })) as unknown as (model: string) => LanguageModel;
}

/**
 * Create a standard provider accessor wrapping a mock registry.
 * Optionally includes an active API key for key rotation tests.
 */
function createMockAccessor(registry: ProviderRegistryProvider, activeApiKey?: string): StandardProviderAccessor {
    return () => ({ registry, activeApiKey });
}

describe("LLMService", () => {
    let mockRegistry: ProviderRegistryProvider;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockStreamText.mockClear();
        mockGenerateText.mockClear();
        mockGenerateObject.mockClear();
    });

    describe("constructor", () => {
        test("throws if no accessor and no agent provider", () => {
            expect(() => {
                new LLMService(null, "openrouter", "gpt-4", mockCapabilities);
            }).toThrow("LLMService requires either a provider accessor or an agent provider function");
        });

        test("accepts a standard provider accessor", () => {
            const service = new LLMService(createMockAccessor(mockRegistry), "openrouter", "gpt-4", mockCapabilities);
            expect(service.provider).toBe("openrouter");
            expect(service.model).toBe("gpt-4");
        });

        test("accepts an agent provider function", () => {
            const agentProvider = createMockAgentProvider();
            const service = new LLMService(
                null,
                "codex",
                "gpt-5-codex",
                mockAgentCapabilities,
                undefined,
                undefined,
                agentProvider
            );
            expect(service.provider).toBe("codex");
        });

        test("stores temperature and maxTokens", () => {
            const service = new LLMService(createMockAccessor(mockRegistry), "openrouter", "gpt-4", mockCapabilities, 0.7, 1000);
            // These are private, but instantiation should succeed.
            expect(service).toBeDefined();
        });
    });

    describe("getModel()", () => {
        test("returns a language model from registry", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);
            const model = service.getModel();
            expect(model).toBeDefined();
        });

        test("returns a language model from an agent provider", () => {
            const agentProvider = createMockAgentProvider();
            const service = new LLMService(
                null,
                "codex",
                "gpt-5-codex",
                mockAgentCapabilities,
                undefined,
                undefined,
                agentProvider
            );
            const model = service.getModel();
            expect(model).toBeDefined();
        });
    });

    describe("cache control", () => {
        test("does not add Anthropic cache control defaults for stream requests", async () => {
            const service = new LLMService(
                createMockAccessor(mockRegistry),
                "anthropic",
                "claude-opus-4-6",
                mockCapabilities,
                undefined,
                undefined,
                undefined,
                undefined,
                "test-agent"
            );

            const messages: ModelMessage[] = [
                { role: "system", content: "System prompt" },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await service.stream(messages, {});

            const callArgs = mockStreamText.mock.calls[0][0];
            expect(callArgs.providerOptions).toBeUndefined();
        });

        test("preserves caller Anthropic provider options over defaults", async () => {
            const service = new LLMService(
                createMockAccessor(mockRegistry),
                "anthropic",
                "claude-opus-4-6",
                mockCapabilities,
                undefined,
                undefined,
                undefined,
                undefined,
                "test-agent"
            );

            await service.stream(
                [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                {},
                {
                    providerOptions: {
                        anthropic: {
                            cacheControl: { type: "ephemeral", ttl: "1h" },
                        },
                    },
                }
            );

            const callArgs = mockStreamText.mock.calls[0][0];
            expect(callArgs.providerOptions.anthropic).toEqual({
                cacheControl: { type: "ephemeral", ttl: "1h" },
            });
        });

        test("does not add Anthropic cache control for non-Anthropic providers", async () => {
            const service = new LLMService(
                createMockAccessor(mockRegistry),
                "openrouter",
                "gpt-4",
                mockCapabilities,
                undefined,
                undefined,
                undefined,
                undefined,
                "test-agent"
            );

            await service.stream([{ role: "user", content: [{ type: "text", text: "Hello" }] }], {});

            const callArgs = mockStreamText.mock.calls[0][0];
            expect(callArgs.providerOptions.anthropic).toBeUndefined();
        });

        test("does not add Anthropic cache control defaults for generateText", async () => {
            const service = new LLMService(
                createMockAccessor(mockRegistry),
                "anthropic",
                "claude-opus-4-6",
                mockCapabilities,
                undefined,
                undefined,
                undefined,
                undefined,
                "test-agent"
            );

            await service.generateText([{ role: "user", content: [{ type: "text", text: "Hello" }] }]);

            const callArgs = mockGenerateText.mock.calls[0][0];
            expect(callArgs.providerOptions).toBeUndefined();
        });

        test("does not add Anthropic cache control defaults for generateObject", async () => {
            const { z } = await import("zod");
            const service = new LLMService(
                createMockAccessor(mockRegistry),
                "anthropic",
                "claude-haiku-4-5",
                mockCapabilities,
                undefined,
                undefined,
                undefined,
                undefined,
                "test-agent"
            );

            await service.generateObject(
                [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                z.object({ result: z.string() })
            );

            const callArgs = mockGenerateObject.mock.calls[0][0];
            expect(callArgs.providerOptions).toBeUndefined();
        });
    });

    describe("generateObject()", () => {
        test("generates a structured object", async () => {
            const { z } = await import("zod");
            const service = new LLMService(
                createMockAccessor(mockRegistry),
                "openrouter",
                "gpt-4",
                mockCapabilities,
                undefined,
                undefined,
                undefined,
                undefined,
                "test-agent"
            );

            const schema = z.object({
                result: z.string(),
            });

            const messages: ModelMessage[] = [
                { role: "user", content: [{ type: "text", text: "Generate something" }] },
            ];

            const result = await service.generateObject(messages, schema);

            expect(result.object).toEqual({ result: "test" });
            expect(result.usage).toBeDefined();
        });
    });
});

describe("LLMService private methods (via behavior)", () => {
    let mockRegistry: ProviderRegistryProvider;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
    });

    describe("tool result error detection", () => {
        test("flags error results via tool-did-execute event", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

            const toolDidExecuteSpy = mock(() => {});
            service.on("tool-did-execute", toolDidExecuteSpy);

            const chunkHandler = (service as any).chunkHandler;

            chunkHandler.handleChunk({
                chunk: {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "testTool",
                    output: { type: "error-text", text: "Something failed" },
                },
            });
            chunkHandler.handleChunk({
                chunk: {
                    type: "tool-result",
                    toolCallId: "call-2",
                    toolName: "testTool",
                    output: { type: "error", message: "Error" },
                },
            });
            chunkHandler.handleChunk({
                chunk: {
                    type: "tool-result",
                    toolCallId: "call-3",
                    toolName: "testTool",
                    output: { success: true, data: "result" },
                },
            });

            expect(toolDidExecuteSpy).toHaveBeenCalledTimes(3);
            expect(toolDidExecuteSpy.mock.calls[0][0].error).toBe(true);
            expect(toolDidExecuteSpy.mock.calls[1][0].error).toBe(true);
            expect(toolDidExecuteSpy.mock.calls[2][0].error).toBe(false);
        });
    });

});

describe("LLMService chunk handling", () => {
    let mockRegistry: ProviderRegistryProvider;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
    });

    describe("handleTextDelta", () => {
        test("emits content event for streaming providers", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

            const contentSpy = mock(() => {});
            service.on("content", contentSpy);

            const chunkHandler = (service as any).chunkHandler;
            chunkHandler.handleChunk({ chunk: { type: "text-delta", text: "Hello, world!" } });

            expect(contentSpy).toHaveBeenCalled();
            expect(contentSpy.mock.calls[0][0]).toEqual({ delta: "Hello, world!" });
        });
    });

    describe("handleReasoningDelta", () => {
        test("emits reasoning event", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

            const reasoningSpy = mock(() => {});
            service.on("reasoning", reasoningSpy);

            const chunkHandler = (service as any).chunkHandler;
            chunkHandler.handleChunk({
                chunk: { type: "reasoning-delta", delta: "Thinking about this..." },
            });

            expect(reasoningSpy).toHaveBeenCalled();
            expect(reasoningSpy.mock.calls[0][0]).toEqual({ delta: "Thinking about this..." });
        });

        test("ignores [REDACTED] reasoning", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

            const reasoningSpy = mock(() => {});
            service.on("reasoning", reasoningSpy);

            const chunkHandler = (service as any).chunkHandler;
            chunkHandler.handleChunk({
                chunk: { type: "reasoning-delta", delta: "[REDACTED]" },
            });

            expect(reasoningSpy).not.toHaveBeenCalled();
        });
    });

    describe("handleToolCall", () => {
        test("emits tool-will-execute event", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

            const toolWillExecuteSpy = mock(() => {});
            service.on("tool-will-execute", toolWillExecuteSpy);

            const chunkHandler = (service as any).chunkHandler;
            chunkHandler.handleChunk({
                chunk: {
                    type: "tool-call",
                    toolCallId: "call-123",
                    toolName: "shell",
                    input: { command: "ls -la" },
                },
            });

            expect(toolWillExecuteSpy).toHaveBeenCalled();
            expect(toolWillExecuteSpy.mock.calls[0][0]).toMatchObject({
                toolCallId: "call-123",
                toolName: "shell",
                args: { command: "ls -la" },
            });
        });
    });

    describe("handleToolResult", () => {
        test("emits tool-did-execute event for successful result", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

            const toolDidExecuteSpy = mock(() => {});
            service.on("tool-did-execute", toolDidExecuteSpy);

            const chunkHandler = (service as any).chunkHandler;
            chunkHandler.handleChunk({
                chunk: {
                    type: "tool-result",
                    toolCallId: "call-123",
                    toolName: "shell",
                    output: { output: "file1.txt\nfile2.txt" },
                },
            });

            expect(toolDidExecuteSpy).toHaveBeenCalled();
            expect(toolDidExecuteSpy.mock.calls[0][0]).toMatchObject({
                toolCallId: "call-123",
                toolName: "shell",
                result: { output: "file1.txt\nfile2.txt" },
                error: false,
            });
        });

        test("emits tool-did-execute event with error: true for error result", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

            const toolDidExecuteSpy = mock(() => {});
            service.on("tool-did-execute", toolDidExecuteSpy);

            const chunkHandler = (service as any).chunkHandler;
            chunkHandler.handleChunk({
                chunk: {
                    type: "tool-result",
                    toolCallId: "call-123",
                    toolName: "shell",
                    output: { type: "error-text", text: "Command failed" },
                },
            });

            expect(toolDidExecuteSpy).toHaveBeenCalled();
            expect(toolDidExecuteSpy.mock.calls[0][0]).toMatchObject({
                toolCallId: "call-123",
                toolName: "shell",
                result: { type: "error-text", text: "Command failed" },
                error: true,
            });
        });
    });

    describe("handleChunk", () => {
        test("emits chunk-type-change when chunk type changes", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

            const chunkTypeChangeSpy = mock(() => {});
            service.on("chunk-type-change", chunkTypeChangeSpy);

            const chunkHandler = (service as any).chunkHandler;

            // First chunk - no event (no previous type)
            chunkHandler.handleChunk({ chunk: { type: "text-delta", text: "Hello" } });
            expect(chunkTypeChangeSpy).not.toHaveBeenCalled();

            // Same type - no event
            chunkHandler.handleChunk({ chunk: { type: "text-delta", text: " world" } });
            expect(chunkTypeChangeSpy).not.toHaveBeenCalled();

            // Different type - emit event
            chunkHandler.handleChunk({
                chunk: { type: "tool-call", toolCallId: "1", toolName: "test", input: {} },
            });
            expect(chunkTypeChangeSpy).toHaveBeenCalled();
            expect(chunkTypeChangeSpy.mock.calls[0][0]).toEqual({
                from: "text-delta",
                to: "tool-call",
            });
        });

        test("handles error chunks", () => {
            const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

            const streamErrorSpy = mock(() => {});
            service.on("stream-error", streamErrorSpy);

            const chunkHandler = (service as any).chunkHandler;
            const error = new Error("Stream error");
            chunkHandler.handleChunk({ chunk: { type: "error", error } });

            expect(streamErrorSpy).toHaveBeenCalled();
            expect(streamErrorSpy.mock.calls[0][0]).toEqual({ error });
        });
    });
});

describe("LLMService telemetry configuration", () => {
    test("generates correct telemetry config", () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            0.7,
            1000,
            undefined,
            undefined,
            "test-agent",
            "conversation-123",
            "project-456",
            "agent-789"
        );

        const getTelemetryConfig = (service as any).getTelemetryConfig.bind(service);
        const config = getTelemetryConfig();

        expect(config.isEnabled).toBe(true);
        expect(config.functionId).toBe("test-agent.openrouter.gpt-4");
        expect(config.metadata["agent.slug"]).toBe("test-agent");
        expect(config.metadata["agent.id"]).toBe("agent-789");
        expect(config.metadata["conversation.id"]).toBe("conversation-123");
        expect(config.metadata["project.id"]).toBe("project-456");
        expect(config.metadata["llm.provider"]).toBe("openrouter");
        expect(config.metadata["llm.model"]).toBe("gpt-4");
        expect(config.recordInputs).toBe(true);
        expect(config.recordOutputs).toBe(true);
    });

    test("throws if agent slug is missing", () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        const getTelemetryConfig = (service as any).getTelemetryConfig.bind(service);

        expect(() => getTelemetryConfig()).toThrow(
            "[TracingUtils] Missing required agentSlug for telemetry."
        );
    });
});

describe("LLMService stream()", () => {
    let mockRegistry: ProviderRegistryProvider;
    let capturedOnFinish: ((e: any) => Promise<void>) | undefined;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        capturedOnFinish = undefined;

        // Clear mock calls from previous tests
        mockStreamText.mockClear();

        // Override mock to capture callbacks
        mockStreamText.mockImplementation((options: any) => {
            capturedOnFinish = options.onFinish;

            return {
                textStream: (async function* () {
                    // Simulate chunks being emitted
                    yield "Hello";
                    yield " world";
                })(),
                fullStream: (async function* () {
                    yield { type: "text-delta", text: "Hello" };
                    yield { type: "text-delta", text: " world" };
                    yield { type: "finish", finishReason: "stop" };
                })(),
            };
        });
    });

    test("calls streamText with correct parameters", async () => {
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            0.7,
            2000,
            undefined,
            undefined,
            "test-agent"
        );

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];
        const tools = { testTool: {} as any };

        await service.stream(messages, tools);

        expect(mockStreamText).toHaveBeenCalled();
        const callArgs = mockStreamText.mock.calls[0][0];
        expect(callArgs.messages).toEqual(messages);
        expect(callArgs.tools).toEqual(tools);
        expect(callArgs.temperature).toBe(0.7);
        expect(callArgs.maxOutputTokens).toBe(2000);
    });

    test("does not pass tools for providers with builtInTools capability", async () => {
        const agentProvider = createMockAgentProvider();
        const service = new LLMService(
            null,
            "codex",
            "gpt-5-codex",
            mockAgentCapabilities,
            undefined,
            undefined,
            agentProvider,
            undefined,
            "test-agent"
        );

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];
        const tools = { testTool: {} as any };

        await service.stream(messages, tools);

        const callArgs = mockStreamText.mock.calls[0][0];
        expect(callArgs.tools).toBeUndefined();
    });

    test("emits complete event via onFinish callback", async () => {
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent"
        );

        const completeSpy = mock(() => {});
        service.on("complete", completeSpy);

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {});

        // Simulate onFinish being called
        if (capturedOnFinish) {
            await capturedOnFinish({
                text: "Response text",
                steps: [],
                totalUsage: { inputTokens: 10, outputTokens: 20 },
                finishReason: "stop",
                providerMetadata: {},
            });
        }

        expect(completeSpy).toHaveBeenCalled();
        const completeEvent = completeSpy.mock.calls[0][0];
        expect(completeEvent.finishReason).toBe("stop");
    });

    test("extracts OpenRouter usage metadata including token counts", async () => {
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent"
        );

        const completeSpy = mock(() => {});
        service.on("complete", completeSpy);

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {});

        if (capturedOnFinish) {
            await capturedOnFinish({
                text: "Response",
                steps: [],
                totalUsage: { inputTokens: 100, outputTokens: 200 }, // AI SDK fallback
                finishReason: "stop",
                providerMetadata: {
                    openrouter: {
                        usage: {
                            cost: 0.0025,
                            promptTokens: 4757, // OpenRouter-specific naming
                            completionTokens: 12,
                            totalTokens: 4769,
                            promptTokensDetails: { cachedTokens: 50 },
                            completionTokensDetails: { reasoningTokens: 30 },
                        },
                    },
                },
            });
        }

        expect(completeSpy).toHaveBeenCalled();
        const completeEvent = completeSpy.mock.calls[0][0];
        // Token counts should come from OpenRouter metadata (primary source)
        expect(completeEvent.usage.inputTokens).toBe(4757);
        expect(completeEvent.usage.outputTokens).toBe(12);
        expect(completeEvent.usage.totalTokens).toBe(4769);
        // Other OpenRouter-specific fields
        expect(completeEvent.usage.costUsd).toBe(0.0025);
        expect(completeEvent.usage.cachedInputTokens).toBe(50);
        expect(completeEvent.usage.reasoningTokens).toBe(30);
    });

    test("falls back to AI SDK totalUsage when OpenRouter token counts unavailable", async () => {
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent"
        );

        const completeSpy = mock(() => {});
        service.on("complete", completeSpy);

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {});

        if (capturedOnFinish) {
            await capturedOnFinish({
                text: "Response",
                steps: [],
                totalUsage: { inputTokens: 100, outputTokens: 200 },
                finishReason: "stop",
                providerMetadata: {
                    openrouter: {
                        usage: {
                            cost: 0.0025,
                            // No token counts in provider metadata
                            promptTokensDetails: { cachedTokens: 50 },
                            completionTokensDetails: { reasoningTokens: 30 },
                        },
                    },
                },
            });
        }

        expect(completeSpy).toHaveBeenCalled();
        const completeEvent = completeSpy.mock.calls[0][0];
        // Should fall back to AI SDK totalUsage
        expect(completeEvent.usage.inputTokens).toBe(100);
        expect(completeEvent.usage.outputTokens).toBe(200);
        expect(completeEvent.usage.totalTokens).toBe(300); // Calculated fallback
    });

    test("extracts Codex thread and tool metadata from provider metadata", async () => {
        const agentProvider = createMockAgentProvider();
        const service = new LLMService(
            null,
            "codex",
            "gpt-5-codex",
            mockAgentCapabilities,
            undefined,
            undefined,
            agentProvider,
            undefined,
            "test-agent"
        );

        const completeSpy = mock(() => {});
        service.on("complete", completeSpy);

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {});

        if (capturedOnFinish) {
            await capturedOnFinish({
                text: "Response",
                steps: [],
                totalUsage: { inputTokens: 55865, outputTokens: 324 },
                finishReason: "stop",
                providerMetadata: {
                    "codex-app-server": {
                        threadId: "thread_123",
                        turnId: "turn_456",
                        toolExecutionStats: {
                            totalCalls: 7,
                            totalDurationMs: 4200,
                            byType: {
                                exec: 2,
                                patch: 1,
                                mcp: 3,
                                web_search: 1,
                                other: 0,
                            },
                        },
                    },
                },
            });
        }

        expect(completeSpy).toHaveBeenCalled();
        const completeEvent = completeSpy.mock.calls[0][0];
        // Token counts should come from AI SDK totalUsage (fallback)
        expect(completeEvent.usage.inputTokens).toBe(55865);
        expect(completeEvent.usage.outputTokens).toBe(324);
        expect(completeEvent.usage.costUsd).toBeUndefined();
        expect(completeEvent.metadata).toEqual({
            threadId: "thread_123",
            turnId: "turn_456",
            toolTotalCalls: 7,
            toolTotalDurationMs: 4200,
            toolCommandCalls: 2,
            toolFileChangeCalls: 1,
            toolMcpCalls: 3,
            toolOtherCalls: 1,
        });
    });

    test("respects custom onStopCheck callback", async () => {
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent"
        );

        let capturedStopWhen: ((args: { steps: any[] }) => Promise<boolean>) | undefined;

        mockStreamText.mockImplementationOnce((options: any) => {
            capturedStopWhen = options.stopWhen;
            return {
                textStream: (async function* () {
                    yield "test";
                })(),
                fullStream: (async function* () {
                    yield { type: "text-delta", text: "test" };
                    yield { type: "finish", finishReason: "stop" };
                })(),
            };
        });

        const onStopCheck = mock(() => Promise.resolve(true));

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {}, { onStopCheck });

        // Test that stopWhen respects our callback
        if (capturedStopWhen) {
            const result = await capturedStopWhen({ steps: [] });
            expect(result).toBe(true);
            expect(onStopCheck).toHaveBeenCalled();
        }
    });

    test("passes abort signal to streamText", async () => {
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent"
        );
        const abortController = new AbortController();

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {}, { abortSignal: abortController.signal });

        const callArgs = mockStreamText.mock.calls[0][0];
        expect(callArgs.abortSignal).toBe(abortController.signal);
    });

    test("passes a wrapped prepareStep to streamText", async () => {
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent"
        );
        const prepareStep = mock(() => ({ messages: [] }));

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {}, { prepareStep });

        const callArgs = mockStreamText.mock.calls[0][0];
        expect(typeof callArgs.prepareStep).toBe("function");

        const prepared = await callArgs.prepareStep({
            messages,
            stepNumber: 0,
            steps: [],
        });

        expect(prepareStep).toHaveBeenCalled();
        expect(prepared).toEqual({ messages: [] });
    });

    test("opens and finalizes analysis requests for each stream step", async () => {
        const reportSuccesses = [mock(async () => {}), mock(async () => {})];
        const reportErrors = [mock(async () => {}), mock(async () => {})];
        const openRequest = mock(async ({ requestSeed }: { requestSeed?: { requestId: string } }) => {
            const index = openRequest.mock.calls.length - 1;
            return {
                requestId: requestSeed?.requestId ?? `request-${index + 1}`,
                telemetryMetadata: requestSeed
                    ? { "analysis.request_id": requestSeed.requestId }
                    : {},
                reportSuccess: reportSuccesses[index],
                reportError: reportErrors[index],
            };
        });
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent",
            "conv-1",
            "proj-1",
            "agent-1",
            { openRequest }
        );
        const prepareStep = mock(({ stepNumber }: { stepNumber: number }) => ({
            messages: [
                {
                    role: "user" as const,
                    content: [{ type: "text" as const, text: `step-${stepNumber}` }],
                },
            ],
            analysisRequestSeed: {
                requestId: `seed-${stepNumber}`,
                telemetryMetadata: {
                    "analysis.request_id": `seed-${stepNumber}`,
                },
            },
        }));

        mockStreamText.mockImplementation((options: any) => ({
            fullStream: (async function* () {
                await options.prepareStep({
                    messages: options.messages,
                    stepNumber: 0,
                    steps: [],
                });
                await options.onStepFinish({
                    stepNumber: 0,
                    finishReason: "tool-calls",
                    usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
                    providerMetadata: undefined,
                    model: { provider: "openrouter", modelId: "gpt-4" },
                });
                await options.prepareStep({
                    messages: options.messages,
                    stepNumber: 1,
                    steps: [
                        {
                            toolCalls: [],
                            text: "",
                            usage: { inputTokens: 11, outputTokens: 5 },
                        },
                    ],
                });
                await options.onStepFinish({
                    stepNumber: 1,
                    finishReason: "stop",
                    usage: { inputTokens: 29, outputTokens: 7, totalTokens: 36 },
                    providerMetadata: undefined,
                    model: { provider: "openrouter", modelId: "gpt-4" },
                });
                yield { type: "finish", finishReason: "stop" };
            })(),
        }));

        await service.stream(
            [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
            {},
            { prepareStep }
        );

        expect(openRequest).toHaveBeenCalledTimes(2);
        expect(openRequest.mock.calls[0][0].requestSeed?.requestId).toBe("seed-0");
        expect(openRequest.mock.calls[1][0].requestSeed?.requestId).toBe("seed-1");
        expect(reportSuccesses[0]).toHaveBeenCalled();
        expect(reportSuccesses[1]).toHaveBeenCalled();
        expect(reportErrors[0]).not.toHaveBeenCalled();
        expect(reportErrors[1]).not.toHaveBeenCalled();
    });

    test("treats a stream without a finish part as an error and finalizes open analysis steps", async () => {
        const reportSuccess = mock(async () => {});
        const reportError = mock(async () => {});
        const openRequest = mock(async () => ({
            requestId: "request-1",
            telemetryMetadata: {},
            reportSuccess,
            reportError,
        }));
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent",
            "conv-1",
            "proj-1",
            "agent-1",
            { openRequest }
        );

        mockStreamText.mockImplementation((options: any) => ({
            fullStream: (async function* () {
                await options.prepareStep?.({
                    messages: options.messages,
                    stepNumber: 0,
                    steps: [],
                });
                yield { type: "text-delta", textDelta: "hello" };
            })(),
        }));

        await expect(service.stream(
            [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
            {},
            {}
        )).rejects.toThrow("Incomplete stream");

        expect(reportSuccess).not.toHaveBeenCalled();
        expect(reportError).toHaveBeenCalledTimes(1);
    });

    test("treats a stream with a finish part but missing step finish as an error", async () => {
        const reportSuccess = mock(async () => {});
        const reportError = mock(async () => {});
        const openRequest = mock(async () => ({
            requestId: "request-1",
            telemetryMetadata: {},
            reportSuccess,
            reportError,
        }));
        const service = new LLMService(
            createMockAccessor(mockRegistry),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent",
            "conv-1",
            "proj-1",
            "agent-1",
            { openRequest }
        );

        mockStreamText.mockImplementation((options: any) => ({
            fullStream: (async function* () {
                await options.prepareStep?.({
                    messages: options.messages,
                    stepNumber: 0,
                    steps: [],
                });
                yield { type: "finish", finishReason: "stop" };
            })(),
        }));

        await expect(service.stream(
            [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
            {},
            {}
        )).rejects.toThrow("Incomplete stream");

        expect(reportSuccess).not.toHaveBeenCalled();
        expect(reportError).toHaveBeenCalledTimes(1);
    });
});

describe("LLMService createFinishHandler", () => {
    let mockRegistry: ProviderRegistryProvider;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        // Clear mock span calls between tests
        mockSpan.addEvent.mockClear();
    });

    test("uses cached content for non-streaming providers", async () => {
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        let cachedContent = "Cached response text";

        const completeSpy = mock(() => {});
        service.on("complete", completeSpy);

        const finishHandler = createFinishHandler(
            service,
            {
                provider: "openrouter",
                model: "gpt-4",
                getModelContextWindow: () => undefined,
            },
            {
                getCachedContent: () => cachedContent,
                clearCachedContent: () => {
                    cachedContent = "";
                },
                getLastUserMessage: () => undefined,
                clearLastUserMessage: () => {},
            }
        );

        await finishHandler({
            text: "", // Empty text from stream
            steps: [],
            totalUsage: { inputTokens: 5, outputTokens: 10 },
            finishReason: "stop",
            providerMetadata: {},
        });

        expect(completeSpy).toHaveBeenCalled();
        expect(completeSpy.mock.calls[0][0].message).toBe("Cached response text");
    });

    test("clears cached content after use", async () => {
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        let cachedContent = "Some cached content";

        const finishHandler = createFinishHandler(
            service,
            {
                provider: "openrouter",
                model: "gpt-4",
                getModelContextWindow: () => undefined,
            },
            {
                getCachedContent: () => cachedContent,
                clearCachedContent: () => {
                    cachedContent = "";
                },
                getLastUserMessage: () => undefined,
                clearLastUserMessage: () => {},
            }
        );

        await finishHandler({
            text: "",
            steps: [],
            totalUsage: {},
            finishReason: "stop",
            providerMetadata: {},
        });

        expect(cachedContent).toBe("");
    });

    test("detects invalid tool calls and logs error", async () => {
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        const finishHandler = createFinishHandler(
            service,
            {
                provider: "openrouter",
                model: "gpt-4",
                getModelContextWindow: () => undefined,
            },
            {
                getCachedContent: () => "",
                clearCachedContent: () => {},
                getLastUserMessage: () => undefined,
                clearLastUserMessage: () => {},
            }
        );

        // Simulate steps with invalid tool call
        await finishHandler({
            text: "Response",
            steps: [
                {
                    toolCalls: [
                        {
                            toolName: "invalidTool",
                            dynamic: true,
                            invalid: true,
                            error: { name: "ValidationError" },
                        },
                    ],
                },
            ],
            totalUsage: {},
            finishReason: "stop",
            providerMetadata: {},
        });

        // The test verifies no exception is thrown and the handler completes
        // Error logging is verified by the mock
    });

    test("emits e.text when cachedContent is empty and e.text is non-empty", async () => {
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        const completeSpy = mock(() => {});
        service.on("complete", completeSpy);

        const finishHandler = createFinishHandler(
            service,
            {
                provider: "openrouter",
                model: "gpt-4",
                getModelContextWindow: () => undefined,
            },
            {
                getCachedContent: () => "", // Empty cached content
                clearCachedContent: () => {},
                getLastUserMessage: () => undefined,
                clearLastUserMessage: () => {},
            }
        );

        await finishHandler({
            text: "Fallback text from e.text", // Non-empty e.text
            steps: [],
            totalUsage: { inputTokens: 10, outputTokens: 20 },
            finishReason: "stop",
            providerMetadata: {},
        });

        expect(completeSpy).toHaveBeenCalled();
        expect(completeSpy.mock.calls[0][0].message).toBe("Fallback text from e.text");
    });

    test("emits error fallback when both cachedContent and e.text are empty", async () => {
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        const completeSpy = mock(() => {});
        service.on("complete", completeSpy);

        const finishHandler = createFinishHandler(
            service,
            {
                provider: "openrouter",
                model: "gpt-4",
                getModelContextWindow: () => undefined,
            },
            {
                getCachedContent: () => "", // Empty cached content
                clearCachedContent: () => {},
                getLastUserMessage: () => undefined,
                clearLastUserMessage: () => {},
            }
        );

        await finishHandler({
            text: "", // Empty e.text
            steps: [],
            totalUsage: { inputTokens: 10, outputTokens: 20 },
            finishReason: "stop",
            providerMetadata: {},
        });

        expect(completeSpy).toHaveBeenCalled();
        expect(completeSpy.mock.calls[0][0].message).toBe(
            "There was an error capturing the work done, please review the conversation for the results"
        );
    });

    test("emits error fallback when cachedContent is empty and e.text is undefined", async () => {
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        const completeSpy = mock(() => {});
        service.on("complete", completeSpy);

        const finishHandler = createFinishHandler(
            service,
            {
                provider: "openrouter",
                model: "gpt-4",
                getModelContextWindow: () => undefined,
            },
            {
                getCachedContent: () => "", // Empty cached content
                clearCachedContent: () => {},
                getLastUserMessage: () => undefined,
                clearLastUserMessage: () => {},
            }
        );

        await finishHandler({
            text: undefined, // Undefined e.text
            steps: [],
            totalUsage: { inputTokens: 10, outputTokens: 20 },
            finishReason: "stop",
            providerMetadata: {},
        });

        expect(completeSpy).toHaveBeenCalled();
        expect(completeSpy.mock.calls[0][0].message).toBe(
            "There was an error capturing the work done, please review the conversation for the results"
        );
    });

    test("telemetry flags match emitted message for cached content", async () => {
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        service.on("complete", mock(() => {}));

        const finishHandler = createFinishHandler(
            service,
            {
                provider: "openrouter",
                model: "gpt-4",
                getModelContextWindow: () => undefined,
            },
            {
                getCachedContent: () => "Cached content",
                clearCachedContent: () => {},
                getLastUserMessage: () => undefined,
                clearLastUserMessage: () => {},
            }
        );

        await finishHandler({
            text: "Some other text",
            steps: [],
            totalUsage: {},
            finishReason: "stop",
            providerMetadata: {},
        });

        // Verify mockSpan.addEvent was called with correct flags
        expect(mockSpan.addEvent).toHaveBeenCalled();
        const eventCalls = mockSpan.addEvent.mock.calls.filter(
            (call: any) => call[0] === "llm.complete_will_emit"
        );
        expect(eventCalls.length).toBeGreaterThan(0);
        const eventData = eventCalls[0][1];
        expect(eventData["complete.used_fallback_to_e_text"]).toBe(false);
        expect(eventData["complete.used_error_fallback"]).toBe(false);
    });

    test("telemetry flags match emitted message for e.text fallback", async () => {
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        service.on("complete", mock(() => {}));

        const finishHandler = createFinishHandler(
            service,
            {
                provider: "openrouter",
                model: "gpt-4",
                getModelContextWindow: () => undefined,
            },
            {
                getCachedContent: () => "", // Empty cached content
                clearCachedContent: () => {},
                getLastUserMessage: () => undefined,
                clearLastUserMessage: () => {},
            }
        );

        await finishHandler({
            text: "Fallback text",
            steps: [],
            totalUsage: {},
            finishReason: "stop",
            providerMetadata: {},
        });

        // Verify mockSpan.addEvent was called with correct flags
        expect(mockSpan.addEvent).toHaveBeenCalled();
        const eventCalls = mockSpan.addEvent.mock.calls.filter(
            (call: any) => call[0] === "llm.complete_will_emit"
        );
        expect(eventCalls.length).toBeGreaterThan(0);
        const eventData = eventCalls[0][1];
        expect(eventData["complete.used_fallback_to_e_text"]).toBe(true);
        expect(eventData["complete.used_error_fallback"]).toBe(false);
    });

    test("telemetry flags match emitted message for error fallback", async () => {
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        service.on("complete", mock(() => {}));

        const finishHandler = createFinishHandler(
            service,
            {
                provider: "openrouter",
                model: "gpt-4",
                getModelContextWindow: () => undefined,
            },
            {
                getCachedContent: () => "", // Empty cached content
                clearCachedContent: () => {},
                getLastUserMessage: () => undefined,
                clearLastUserMessage: () => {},
            }
        );

        await finishHandler({
            text: "", // Empty e.text
            steps: [],
            totalUsage: {},
            finishReason: "stop",
            providerMetadata: {},
        });

        // Verify mockSpan.addEvent was called with correct flags
        expect(mockSpan.addEvent).toHaveBeenCalled();
        const eventCalls = mockSpan.addEvent.mock.calls.filter(
            (call: any) => call[0] === "llm.complete_will_emit"
        );
        expect(eventCalls.length).toBeGreaterThan(0);
        const eventData = eventCalls[0][1];
        expect(eventData["complete.used_fallback_to_e_text"]).toBe(false);
        expect(eventData["complete.used_error_fallback"]).toBe(true);
    });
});

describe("LLMService handleStreamError", () => {
    test("logs stream errors with duration", async () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        const handleStreamError = (service as any).handleStreamError.bind(service);

        // Should not throw
        await handleStreamError(new Error("Stream failed"), Date.now() - 1000);
    });

    test("handles non-Error objects", async () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(createMockAccessor(mockRegistry),"openrouter", "gpt-4", mockCapabilities);

        const handleStreamError = (service as any).handleStreamError.bind(service);

        // Should not throw when error is a string
        await handleStreamError("String error", Date.now());
    });
});

describe("LLMService message preparation", () => {
    test("preserves messages when preparing request input", async () => {
        mockStreamText.mockClear();
        mockStreamText.mockImplementation(() => ({
            fullStream: (async function* () {
                yield { type: "finish", finishReason: "stop" };
            })(),
        }));
        const service = new LLMService(
            createMockAccessor(createMockRegistry()),
            "anthropic",
            "claude-opus-4-6",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent"
        );
        const messages: ModelMessage[] = [
            {
                role: "system",
                content: "system",
                customProperty: "preserved",
            } as any,
        ];

        await service.stream(messages, {});

        const callArgs = mockStreamText.mock.calls[0][0];
        expect((callArgs.messages[0] as any).customProperty).toBe("preserved");
        expect(callArgs.messages[0].providerOptions).toBeUndefined();
    });
});

// ============================================================================
// Key Rotation Retry Tests
// ============================================================================

describe("LLMService key rotation retry", () => {
    let mockRegistry: ProviderRegistryProvider;
    let mockRotationHandler: ReturnType<typeof mock>;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockRotationHandler = mock(() => Promise.resolve(true));
        mockStreamText.mockClear();
    });

    function createServiceWithRotation(activeApiKey = "test-key-1"): LLMService {
        return new LLMService(
            createMockAccessor(mockRegistry, activeApiKey),
            "openrouter",
            "gpt-4",
            mockCapabilities,
            undefined,
            undefined,
            undefined,
            undefined,
            "test-agent",
            undefined,
            undefined,
            undefined,
            undefined,
            mockRotationHandler as KeyRotationHandler
        );
    }

    describe("stream() retry", () => {
        test("retries once when first attempt fails before any chunks with retryable key error", async () => {
            let callCount = 0;
            mockStreamText.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return {
                        fullStream: throwingStream(Object.assign(new Error("Unauthorized"), { status: 401 })),
                    };
                }
                return {
                    fullStream: (async function* () {
                        yield { type: "text-delta", textDelta: "Hello" };
                        yield { type: "finish", finishReason: "stop" };
                    })(),
                };
            });

            const service = createServiceWithRotation();
            const streamErrorSpy = mock(() => {});
            service.on("stream-error", streamErrorSpy);

            await service.stream(
                [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                {}
            );

            expect(callCount).toBe(2);
            expect(mockRotationHandler).toHaveBeenCalledTimes(1);
            expect(streamErrorSpy).not.toHaveBeenCalled();
        });

        test("retries when the first attempt only emitted protocol chunks before failing", async () => {
            let callCount = 0;
            mockStreamText.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return {
                        fullStream: (async function* () {
                            yield { type: "start" };
                            throw Object.assign(new Error("Rate limited"), { status: 429 });
                        })(),
                    };
                }
                return {
                    fullStream: (async function* () {
                        yield { type: "text-delta", text: "Hello" };
                        yield { type: "finish", finishReason: "stop" };
                    })(),
                };
            });

            const service = createServiceWithRotation();
            const streamErrorSpy = mock(() => {});
            service.on("stream-error", streamErrorSpy);

            await service.stream(
                [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                {}
            );

            expect(callCount).toBe(2);
            expect(mockRotationHandler).toHaveBeenCalledTimes(1);
            expect(streamErrorSpy).not.toHaveBeenCalled();
        });

        test("retries after text chunks have been emitted", async () => {
            let callCount = 0;
            mockStreamText.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return {
                        fullStream: (async function* () {
                            yield { type: "text-delta", text: "Hello" };
                            throw Object.assign(new Error("Rate limited"), { status: 429 });
                        })(),
                    };
                }
                return {
                    fullStream: (async function* () {
                        yield { type: "text-delta", text: "Recovered" };
                        yield { type: "finish", finishReason: "stop" };
                    })(),
                };
            });

            const service = createServiceWithRotation();
            const streamErrorSpy = mock(() => {});
            service.on("stream-error", streamErrorSpy);

            await service.stream(
                [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                {}
            );

            expect(callCount).toBe(2);
            expect(mockRotationHandler).toHaveBeenCalledTimes(1);
            expect(streamErrorSpy).not.toHaveBeenCalled();
        });

        test("retries after a tool call has been emitted", async () => {
            let callCount = 0;
            mockStreamText.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return {
                        fullStream: (async function* () {
                            yield {
                                type: "tool-call",
                                toolCallId: "call-1",
                                toolName: "lookup",
                                input: {},
                            };
                            throw Object.assign(new Error("Rate limited"), { status: 429 });
                        })(),
                    };
                }
                return {
                    fullStream: (async function* () {
                        yield { type: "text-delta", text: "Recovered" };
                        yield { type: "finish", finishReason: "stop" };
                    })(),
                };
            });

            const service = createServiceWithRotation();
            const streamErrorSpy = mock(() => {});
            service.on("stream-error", streamErrorSpy);

            await service.stream(
                [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                { lookup: {} as any }
            );

            expect(callCount).toBe(2);
            expect(mockRotationHandler).toHaveBeenCalledTimes(1);
            expect(streamErrorSpy).not.toHaveBeenCalled();
        });

        test("does not emit stream-error on suppressed first attempt", async () => {
            let callCount = 0;
            mockStreamText.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return {
                        fullStream: throwingStream(Object.assign(new Error("Forbidden"), { status: 403 })),
                    };
                }
                return {
                    fullStream: (async function* () {
                        yield { type: "text-delta", textDelta: "OK" };
                        yield { type: "finish", finishReason: "stop" };
                    })(),
                };
            });

            const service = createServiceWithRotation();
            const streamErrorEvents: unknown[] = [];
            service.on("stream-error", (e) => streamErrorEvents.push(e));

            await service.stream(
                [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                {}
            );

            expect(streamErrorEvents).toHaveLength(0);
        });

        test("does not write an error log when the retry succeeds", async () => {
            let callCount = 0;
            mockStreamText.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return {
                        fullStream: throwingStream(Object.assign(new Error("Forbidden"), { status: 403 })),
                    };
                }
                return {
                    fullStream: (async function* () {
                        yield { type: "text-delta", textDelta: "Recovered" };
                        yield { type: "finish", finishReason: "stop" };
                    })(),
                };
            });

            const { logger } = await import("@/utils/logger");
            const warnLogMock = logger.writeToWarnLog as ReturnType<typeof mock>;
            warnLogMock.mockClear();

            const service = createServiceWithRotation();

            await service.stream(
                [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                {}
            );

            expect(warnLogMock).not.toHaveBeenCalled();
        });

        test("propagates error and rotates when retry also fails", async () => {
            mockStreamText.mockImplementation(() => ({
                fullStream: throwingStream(Object.assign(new Error("Unauthorized"), { status: 401 })),
            }));

            const service = createServiceWithRotation();

            await expect(
                service.stream(
                    [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                    {}
                )
            ).rejects.toThrow("Unauthorized");

            // Both attempts failed — rotation was attempted once (before retry)
            expect(mockRotationHandler).toHaveBeenCalledTimes(1);
            // streamText was called twice (first attempt + retry)
            expect(mockStreamText).toHaveBeenCalledTimes(2);
        });

        test("does not retry for non-retryable errors", async () => {
            mockStreamText.mockImplementation(() => ({
                fullStream: throwingStream(Object.assign(new Error("Server error"), { status: 500 })),
            }));

            const service = createServiceWithRotation();

            await expect(
                service.stream(
                    [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                    {}
                )
            ).rejects.toThrow("Server error");

            expect(mockRotationHandler).not.toHaveBeenCalled();
        });

        test("does not retry when no key rotation handler is configured", async () => {
            mockStreamText.mockImplementation(() => ({
                fullStream: throwingStream(Object.assign(new Error("Unauthorized"), { status: 401 })),
            }));

            // Service without rotation handler
            const service = new LLMService(
                createMockAccessor(mockRegistry, "test-key"),
                "openrouter",
                "gpt-4",
                mockCapabilities,
                undefined,
                undefined,
                undefined,
                undefined,
                "test-agent"
            );

            await expect(
                service.stream(
                    [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                    {}
                )
            ).rejects.toThrow("Unauthorized");
        });

        test("does not retry when rotation fails", async () => {
            mockStreamText.mockImplementation(() => ({
                fullStream: throwingStream(Object.assign(new Error("Unauthorized"), { status: 401 })),
            }));

            mockRotationHandler.mockImplementation(() => Promise.resolve(false));

            const service = createServiceWithRotation();

            await expect(
                service.stream(
                    [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                    {}
                )
            ).rejects.toThrow("Unauthorized");

            expect(mockRotationHandler).toHaveBeenCalledTimes(1);
        });
    });

    describe("generateText() retry", () => {
        test("retries once after rotation on retryable key error", async () => {
            let callCount = 0;
            mockGenerateText.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    throw Object.assign(new Error("Rate limited"), { status: 429 });
                }
                return Promise.resolve({
                    text: "Success after rotation",
                    usage: { inputTokens: 10, outputTokens: 5 },
                });
            });

            const service = createServiceWithRotation();
            const result = await service.generateText([
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ]);

            expect(result.text).toBe("Success after rotation");
            expect(mockRotationHandler).toHaveBeenCalledTimes(1);
            expect(callCount).toBe(2);

            // Restore default mock
            mockGenerateText.mockImplementation(() =>
                Promise.resolve({ text: "mock text", usage: { inputTokens: 5, outputTokens: 10 } })
            );
        });

        test("does not retry on non-retryable errors", async () => {
            mockGenerateText.mockImplementation(() => {
                throw Object.assign(new Error("Bad request"), { status: 422 });
            });

            const service = createServiceWithRotation();

            await expect(
                service.generateText([
                    { role: "user", content: [{ type: "text", text: "Hello" }] },
                ])
            ).rejects.toThrow("Bad request");

            expect(mockRotationHandler).not.toHaveBeenCalled();

            // Restore default mock
            mockGenerateText.mockImplementation(() =>
                Promise.resolve({ text: "mock text", usage: { inputTokens: 5, outputTokens: 10 } })
            );
        });
    });

    describe("generateObject() retry", () => {
        test("retries once after rotation on retryable key error", async () => {
            let callCount = 0;
            mockGenerateObject.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    throw Object.assign(new Error("Forbidden"), { status: 403 });
                }
                return Promise.resolve({
                    object: { result: "rotated" },
                    usage: { inputTokens: 10, outputTokens: 5 },
                });
            });

            const { z } = await import("zod");
            const service = createServiceWithRotation();
            const result = await service.generateObject(
                [{ role: "user", content: [{ type: "text", text: "Generate" }] }],
                z.object({ result: z.string() })
            );

            expect(result.object).toEqual({ result: "rotated" });
            expect(mockRotationHandler).toHaveBeenCalledTimes(1);
            expect(callCount).toBe(2);

            // Restore default mock
            mockGenerateObject.mockImplementation(() =>
                Promise.resolve({ object: { result: "test" }, usage: { inputTokens: 5, outputTokens: 10 } })
            );
        });

        test("retries when generateObject receives tools", async () => {
            let callCount = 0;
            mockGenerateObject.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    throw Object.assign(new Error("Forbidden"), { status: 403 });
                }
                return Promise.resolve({
                    object: { result: "with-tools" },
                    usage: { inputTokens: 10, outputTokens: 5 },
                });
            });

            const { z } = await import("zod");
            const service = createServiceWithRotation();
            const result = await service.generateObject(
                [{ role: "user", content: [{ type: "text", text: "Generate" }] }],
                z.object({ result: z.string() }),
                { lookup: {} as any }
            );

            expect(result.object).toEqual({ result: "with-tools" });
            expect(mockRotationHandler).toHaveBeenCalledTimes(1);
            expect(callCount).toBe(2);

            mockGenerateObject.mockImplementation(() =>
                Promise.resolve({ object: { result: "test" }, usage: { inputTokens: 5, outputTokens: 10 } })
            );
        });
    });
});
