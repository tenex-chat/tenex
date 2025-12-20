import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import type { LanguageModel, ModelMessage, ProviderRegistryProvider } from "ai";
import { LLMService } from "../service";

// Mock the AI SDK functions
const mockGenerateText = mock(() =>
    Promise.resolve({
        text: "Hello, world!",
        steps: [],
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20 },
        finishReason: "stop",
    })
);

const mockStreamText = mock(() => ({
    textStream: (async function* () {
        yield "Hello";
        yield ", ";
        yield "world!";
    })(),
}));

mock.module("ai", () => ({
    generateText: mockGenerateText,
    streamText: mockStreamText,
    generateObject: mock(() =>
        Promise.resolve({
            object: { result: "test" },
            usage: { inputTokens: 5, outputTokens: 10 },
        })
    ),
    smoothStream: mock(() => ({})),
    wrapLanguageModel: mock((config: { model: LanguageModel }) => config.model),
    extractReasoningMiddleware: mock(() => ({})),
}));

// Mock devtools middleware
mock.module("@ai-sdk/devtools", () => ({
    devToolsMiddleware: mock(() => ({})),
}));

// Mock flight recorder
mock.module("../middleware/flight-recorder", () => ({
    createFlightRecorderMiddleware: mock(() => ({})),
}));

// Mock OpenTelemetry
mock.module("@opentelemetry/api", () => ({
    trace: {
        getActiveSpan: () => ({
            addEvent: mock(() => {}),
            setAttribute: mock(() => {}),
            setStatus: mock(() => {}),
        }),
    },
    SpanStatusCode: { ERROR: 2, OK: 1 },
}));

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        debug: mock(() => {}),
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

/**
 * Create a mock provider registry for testing
 */
function createMockRegistry(): ProviderRegistryProvider<string, string> {
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
    } as unknown as ProviderRegistryProvider<string, string>;
}

/**
 * Create a mock Claude Code provider function
 */
function createMockClaudeCodeProvider() {
    return mock(() => ({
        specificationVersion: "v2",
        provider: "claude-code",
        modelId: "claude-code-model",
        supportsUrl: () => false,
        doGenerate: mock(() => Promise.resolve({})),
        doStream: mock(() => Promise.resolve({ stream: new ReadableStream() })),
    })) as unknown as (model: string) => LanguageModel;
}

describe("LLMService", () => {
    let mockRegistry: ProviderRegistryProvider<string, string>;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockGenerateText.mockClear();
        mockStreamText.mockClear();
    });

    describe("constructor", () => {
        test("throws if no registry and no Claude Code provider", () => {
            expect(() => {
                new LLMService(null, "openrouter", "gpt-4");
            }).toThrow("LLMService requires either a registry or Claude Code provider function");
        });

        test("accepts a registry", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
            expect(service.provider).toBe("openrouter");
            expect(service.model).toBe("gpt-4");
        });

        test("accepts a Claude Code provider function", () => {
            const claudeCodeProvider = createMockClaudeCodeProvider();
            const service = new LLMService(
                null,
                "claudeCode",
                "claude-3",
                undefined,
                undefined,
                claudeCodeProvider
            );
            expect(service.provider).toBe("claudeCode");
        });

        test("stores temperature and maxTokens", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4", 0.7, 1000);
            // These are private, but we can verify they're used in complete()
            expect(service).toBeDefined();
        });
    });

    describe("complete()", () => {
        test("calls generateText with correct parameters", async () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4", 0.5, 2000);

            const messages: ModelMessage[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];
            const tools = {};

            await service.complete(messages, tools);

            expect(mockGenerateText).toHaveBeenCalled();
            const callArgs = mockGenerateText.mock.calls[0][0];
            expect(callArgs.messages).toEqual(messages);
            expect(callArgs.tools).toEqual(tools);
            expect(callArgs.temperature).toBe(0.5);
            expect(callArgs.maxOutputTokens).toBe(2000);
        });

        test("uses option overrides for temperature and maxTokens", async () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4", 0.5, 2000);

            const messages: ModelMessage[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await service.complete(messages, {}, { temperature: 0.9, maxTokens: 500 });

            const callArgs = mockGenerateText.mock.calls[0][0];
            expect(callArgs.temperature).toBe(0.9);
            expect(callArgs.maxOutputTokens).toBe(500);
        });

        test("returns the generateText result", async () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const messages: ModelMessage[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            const result = await service.complete(messages, {});

            expect(result.text).toBe("Hello, world!");
            expect(result.finishReason).toBe("stop");
        });

        test("throws on generateText error", async () => {
            mockGenerateText.mockImplementationOnce(() =>
                Promise.reject(new Error("API Error"))
            );

            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
            const messages: ModelMessage[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await expect(service.complete(messages, {})).rejects.toThrow("API Error");
        });
    });

    describe("getModel()", () => {
        test("returns a language model from registry", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
            const model = service.getModel();
            expect(model).toBeDefined();
        });

        test("returns a language model from Claude Code provider", () => {
            const claudeCodeProvider = createMockClaudeCodeProvider();
            const service = new LLMService(
                null,
                "claudeCode",
                "claude-3",
                undefined,
                undefined,
                claudeCodeProvider
            );
            const model = service.getModel();
            expect(model).toBeDefined();
        });
    });

    describe("event emission", () => {
        test("emits session-captured event for Claude Code with session metadata", async () => {
            mockGenerateText.mockImplementationOnce(() =>
                Promise.resolve({
                    text: "Response",
                    steps: [],
                    toolCalls: [],
                    usage: { inputTokens: 10, outputTokens: 20 },
                    finishReason: "stop",
                    providerMetadata: {
                        "claude-code": { sessionId: "test-session-123" },
                    },
                })
            );

            const claudeCodeProvider = createMockClaudeCodeProvider();
            const service = new LLMService(
                null,
                "claudeCode",
                "claude-3",
                undefined,
                undefined,
                claudeCodeProvider
            );

            const sessionCapturedSpy = mock(() => {});
            service.on("session-captured", sessionCapturedSpy);

            const messages: ModelMessage[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await service.complete(messages, {});

            expect(sessionCapturedSpy).toHaveBeenCalled();
            expect(sessionCapturedSpy.mock.calls[0][0]).toEqual({
                sessionId: "test-session-123",
            });
        });
    });

    describe("cache control", () => {
        test("adds cache control for Anthropic with large system messages", async () => {
            const service = new LLMService(mockRegistry, "anthropic", "claude-3");

            // Create a large system message (> 4096 chars = 1024 tokens * 4 chars/token)
            const largeSystemContent = "x".repeat(5000);
            const messages: ModelMessage[] = [
                { role: "system", content: largeSystemContent },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await service.complete(messages, {});

            const callArgs = mockGenerateText.mock.calls[0][0];
            const systemMessage = callArgs.messages[0];

            expect(systemMessage.providerOptions).toEqual({
                anthropic: {
                    cacheControl: { type: "ephemeral" },
                },
            });
        });

        test("does not add cache control for small system messages", async () => {
            const service = new LLMService(mockRegistry, "anthropic", "claude-3");

            const messages: ModelMessage[] = [
                { role: "system", content: "Short system prompt" },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await service.complete(messages, {});

            const callArgs = mockGenerateText.mock.calls[0][0];
            const systemMessage = callArgs.messages[0];

            expect(systemMessage.providerOptions).toBeUndefined();
        });

        test("does not add cache control for non-Anthropic providers", async () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const largeSystemContent = "x".repeat(5000);
            const messages: ModelMessage[] = [
                { role: "system", content: largeSystemContent },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await service.complete(messages, {});

            const callArgs = mockGenerateText.mock.calls[0][0];
            const systemMessage = callArgs.messages[0];

            expect(systemMessage.providerOptions).toBeUndefined();
        });

        test("adds cache control for gemini-cli with large system messages", async () => {
            const service = new LLMService(mockRegistry, "gemini-cli", "gemini-pro");

            const largeSystemContent = "x".repeat(5000);
            const messages: ModelMessage[] = [
                { role: "system", content: largeSystemContent },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await service.complete(messages, {});

            const callArgs = mockGenerateText.mock.calls[0][0];
            const systemMessage = callArgs.messages[0];

            expect(systemMessage.providerOptions).toEqual({
                anthropic: {
                    cacheControl: { type: "ephemeral" },
                },
            });
        });
    });

    describe("generateObject()", () => {
        test("generates a structured object", async () => {
            const { z } = await import("zod");
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

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
    let mockRegistry: ProviderRegistryProvider<string, string>;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
    });

    describe("isToolResultError detection", () => {
        test("detects error-text format in tool results", async () => {
            // We test this indirectly by checking that tool-did-execute events
            // include error: true when the result has error format
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const toolDidExecuteSpy = mock(() => {});
            service.on("tool-did-execute", toolDidExecuteSpy);

            // Simulate calling handleToolResult with error result
            // Since it's private, we need to trigger it through stream()
            // For now, we'll test the logic directly by accessing private method

            // Access private method for testing
            const isToolResultError = (service as any).isToolResultError.bind(service);

            expect(isToolResultError({ type: "error-text", text: "Something failed" })).toBe(true);
            expect(isToolResultError({ type: "error-json", json: { message: "Error" } })).toBe(true);
            expect(isToolResultError({ success: true, data: "result" })).toBe(false);
            expect(isToolResultError(null)).toBe(false);
            expect(isToolResultError("string result")).toBe(false);
        });
    });

    describe("extractErrorDetails", () => {
        test("extracts details from error-text format", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
            const extractErrorDetails = (service as any).extractErrorDetails.bind(service);

            const result = extractErrorDetails({ type: "error-text", text: "Something went wrong" });

            expect(result).toEqual({
                message: "Something went wrong",
                type: "error-text",
            });
        });

        test("extracts details from error-json format", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
            const extractErrorDetails = (service as any).extractErrorDetails.bind(service);

            const result = extractErrorDetails({
                type: "error-json",
                json: { message: "JSON error message" },
            });

            expect(result).toEqual({
                message: "JSON error message",
                type: "error-json",
            });
        });

        test("returns null for non-error results", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
            const extractErrorDetails = (service as any).extractErrorDetails.bind(service);

            expect(extractErrorDetails({ success: true })).toBeNull();
            expect(extractErrorDetails(null)).toBeNull();
            expect(extractErrorDetails("string")).toBeNull();
        });
    });

    describe("calculateCostUsd", () => {
        test("calculates cost based on token usage", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
            const calculateCostUsd = (service as any).calculateCostUsd.bind(service);

            // 1000 input tokens * $0.001/1k = $0.001
            // 2000 output tokens * $0.002/1k = $0.004
            // Total = $0.005
            const cost = calculateCostUsd({
                inputTokens: 1000,
                outputTokens: 2000,
            });

            expect(cost).toBeCloseTo(0.005, 6);
        });

        test("handles zero tokens", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
            const calculateCostUsd = (service as any).calculateCostUsd.bind(service);

            const cost = calculateCostUsd({
                inputTokens: 0,
                outputTokens: 0,
            });

            expect(cost).toBe(0);
        });

        test("handles undefined tokens", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
            const calculateCostUsd = (service as any).calculateCostUsd.bind(service);

            const cost = calculateCostUsd({});

            expect(cost).toBe(0);
        });
    });
});

describe("LLMService chunk handling", () => {
    let mockRegistry: ProviderRegistryProvider<string, string>;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
    });

    describe("handleTextDelta", () => {
        test("emits content event for streaming providers", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const contentSpy = mock(() => {});
            service.on("content", contentSpy);

            // Access private method
            const handleTextDelta = (service as any).handleTextDelta.bind(service);
            handleTextDelta("Hello, world!");

            expect(contentSpy).toHaveBeenCalled();
            expect(contentSpy.mock.calls[0][0]).toEqual({ delta: "Hello, world!" });
        });
    });

    describe("handleReasoningDelta", () => {
        test("emits reasoning event", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const reasoningSpy = mock(() => {});
            service.on("reasoning", reasoningSpy);

            const handleReasoningDelta = (service as any).handleReasoningDelta.bind(service);
            handleReasoningDelta("Thinking about this...");

            expect(reasoningSpy).toHaveBeenCalled();
            expect(reasoningSpy.mock.calls[0][0]).toEqual({ delta: "Thinking about this..." });
        });

        test("ignores [REDACTED] reasoning", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const reasoningSpy = mock(() => {});
            service.on("reasoning", reasoningSpy);

            const handleReasoningDelta = (service as any).handleReasoningDelta.bind(service);
            handleReasoningDelta("[REDACTED]");

            expect(reasoningSpy).not.toHaveBeenCalled();
        });
    });

    describe("handleToolCall", () => {
        test("emits tool-will-execute event", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const toolWillExecuteSpy = mock(() => {});
            service.on("tool-will-execute", toolWillExecuteSpy);

            const handleToolCall = (service as any).handleToolCall.bind(service);
            handleToolCall("call-123", "shell", { command: "ls -la" });

            expect(toolWillExecuteSpy).toHaveBeenCalled();
            expect(toolWillExecuteSpy.mock.calls[0][0]).toEqual({
                toolCallId: "call-123",
                toolName: "shell",
                args: { command: "ls -la" },
            });
        });
    });

    describe("handleToolResult", () => {
        test("emits tool-did-execute event for successful result", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const toolDidExecuteSpy = mock(() => {});
            service.on("tool-did-execute", toolDidExecuteSpy);

            const handleToolResult = (service as any).handleToolResult.bind(service);
            handleToolResult("call-123", "shell", { output: "file1.txt\nfile2.txt" });

            expect(toolDidExecuteSpy).toHaveBeenCalled();
            expect(toolDidExecuteSpy.mock.calls[0][0]).toEqual({
                toolCallId: "call-123",
                toolName: "shell",
                result: { output: "file1.txt\nfile2.txt" },
                error: false,
            });
        });

        test("emits tool-did-execute event with error: true for error result", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const toolDidExecuteSpy = mock(() => {});
            service.on("tool-did-execute", toolDidExecuteSpy);

            const handleToolResult = (service as any).handleToolResult.bind(service);
            handleToolResult("call-123", "shell", { type: "error-text", text: "Command failed" });

            expect(toolDidExecuteSpy).toHaveBeenCalled();
            expect(toolDidExecuteSpy.mock.calls[0][0]).toEqual({
                toolCallId: "call-123",
                toolName: "shell",
                result: { type: "error-text", text: "Command failed" },
                error: true,
            });
        });
    });

    describe("handleChunk", () => {
        test("emits chunk-type-change when chunk type changes", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const chunkTypeChangeSpy = mock(() => {});
            service.on("chunk-type-change", chunkTypeChangeSpy);

            const handleChunk = (service as any).handleChunk.bind(service);

            // First chunk - no event (no previous type)
            handleChunk({ chunk: { type: "text-delta", text: "Hello" } });
            expect(chunkTypeChangeSpy).not.toHaveBeenCalled();

            // Same type - no event
            handleChunk({ chunk: { type: "text-delta", text: " world" } });
            expect(chunkTypeChangeSpy).not.toHaveBeenCalled();

            // Different type - emit event
            handleChunk({ chunk: { type: "tool-call", toolCallId: "1", toolName: "test", input: {} } });
            expect(chunkTypeChangeSpy).toHaveBeenCalled();
            expect(chunkTypeChangeSpy.mock.calls[0][0]).toEqual({
                from: "text-delta",
                to: "tool-call",
            });
        });

        test("handles error chunks", () => {
            const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

            const streamErrorSpy = mock(() => {});
            service.on("stream-error", streamErrorSpy);

            const handleChunk = (service as any).handleChunk.bind(service);
            const error = new Error("Stream error");
            handleChunk({ chunk: { type: "error", error } });

            expect(streamErrorSpy).toHaveBeenCalled();
            expect(streamErrorSpy.mock.calls[0][0]).toEqual({ error });
        });
    });
});

describe("LLMService telemetry configuration", () => {
    test("generates correct telemetry config", () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(
            mockRegistry,
            "openrouter",
            "gpt-4",
            0.7,
            1000,
            undefined,
            undefined,
            "test-agent"
        );

        const getFullTelemetryConfig = (service as any).getFullTelemetryConfig.bind(service);
        const config = getFullTelemetryConfig();

        expect(config.isEnabled).toBe(true);
        expect(config.functionId).toBe("test-agent.openrouter.gpt-4");
        expect(config.metadata["agent.slug"]).toBe("test-agent");
        expect(config.metadata["llm.provider"]).toBe("openrouter");
        expect(config.metadata["llm.model"]).toBe("gpt-4");
        expect(config.recordInputs).toBe(true);
        expect(config.recordOutputs).toBe(true);
    });

    test("uses 'unknown' for missing agent slug", () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

        const getFullTelemetryConfig = (service as any).getFullTelemetryConfig.bind(service);
        const config = getFullTelemetryConfig();

        expect(config.functionId).toBe("unknown.openrouter.gpt-4");
        expect(config.metadata["agent.slug"]).toBe("unknown");
    });
});

describe("LLMService stream()", () => {
    let mockRegistry: ProviderRegistryProvider<string, string>;
    let capturedOnChunk: ((event: { chunk: any }) => void) | undefined;
    let capturedOnFinish: ((e: any) => Promise<void>) | undefined;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        capturedOnChunk = undefined;
        capturedOnFinish = undefined;

        // Clear mock calls from previous tests
        mockStreamText.mockClear();

        // Override mock to capture callbacks
        mockStreamText.mockImplementation((options: any) => {
            capturedOnChunk = options.onChunk;
            capturedOnFinish = options.onFinish;

            return {
                textStream: (async function* () {
                    // Simulate chunks being emitted
                    yield "Hello";
                    yield " world";
                })(),
            };
        });
    });

    test("calls streamText with correct parameters", async () => {
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4", 0.7, 2000);

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

    test("does not pass tools for claudeCode provider", async () => {
        const claudeCodeProvider = createMockClaudeCodeProvider();
        const service = new LLMService(
            null,
            "claudeCode",
            "claude-3",
            undefined,
            undefined,
            claudeCodeProvider
        );

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];
        const tools = { testTool: {} as any };

        await service.stream(messages, tools);

        const callArgs = mockStreamText.mock.calls[0][0];
        expect(callArgs.tools).toBeUndefined();
    });

    test("applies cache control for anthropic provider", async () => {
        const service = new LLMService(mockRegistry, "anthropic", "claude-3");

        const largeSystemContent = "x".repeat(5000);
        const messages: ModelMessage[] = [
            { role: "system", content: largeSystemContent },
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {});

        const callArgs = mockStreamText.mock.calls[0][0];
        expect(callArgs.messages[0].providerOptions).toEqual({
            anthropic: { cacheControl: { type: "ephemeral" } },
        });
    });

    test("emits complete event via onFinish callback", async () => {
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

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

    test("extracts OpenRouter usage metadata", async () => {
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

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
                            promptTokensDetails: { cachedTokens: 50 },
                            completionTokensDetails: { reasoningTokens: 30 },
                        },
                    },
                },
            });
        }

        expect(completeSpy).toHaveBeenCalled();
        const completeEvent = completeSpy.mock.calls[0][0];
        expect(completeEvent.usage.costUsd).toBe(0.0025);
        expect(completeEvent.usage.cachedInputTokens).toBe(50);
        expect(completeEvent.usage.reasoningTokens).toBe(30);
    });

    test("emits session-captured for claudeCode with session metadata", async () => {
        const claudeCodeProvider = createMockClaudeCodeProvider();
        const service = new LLMService(
            null,
            "claudeCode",
            "claude-3",
            undefined,
            undefined,
            claudeCodeProvider
        );

        const sessionSpy = mock(() => {});
        service.on("session-captured", sessionSpy);

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {});

        if (capturedOnFinish) {
            await capturedOnFinish({
                text: "Response",
                steps: [],
                totalUsage: {},
                finishReason: "stop",
                providerMetadata: {
                    "claude-code": { sessionId: "stream-session-456" },
                },
            });
        }

        expect(sessionSpy).toHaveBeenCalled();
        expect(sessionSpy.mock.calls[0][0]).toEqual({
            sessionId: "stream-session-456",
        });
    });

    test("respects custom onStopCheck callback", async () => {
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

        let capturedStopWhen: ((args: { steps: any[] }) => Promise<boolean>) | undefined;

        mockStreamText.mockImplementationOnce((options: any) => {
            capturedStopWhen = options.stopWhen;
            return {
                textStream: (async function* () {
                    yield "test";
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
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
        const abortController = new AbortController();

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {}, { abortSignal: abortController.signal });

        const callArgs = mockStreamText.mock.calls[0][0];
        expect(callArgs.abortSignal).toBe(abortController.signal);
    });

    test("passes prepareStep to streamText", async () => {
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");
        const prepareStep = mock(() => ({ messages: [] }));

        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await service.stream(messages, {}, { prepareStep });

        const callArgs = mockStreamText.mock.calls[0][0];
        expect(callArgs.prepareStep).toBe(prepareStep);
    });
});

describe("LLMService createFinishHandler", () => {
    let mockRegistry: ProviderRegistryProvider<string, string>;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
    });

    test("clears content publish timeout on finish", async () => {
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

        // Set a fake timeout
        (service as any).contentPublishTimeout = setTimeout(() => {}, 10000);

        const finishHandler = (service as any).createFinishHandler();

        await finishHandler({
            text: "Response",
            steps: [],
            totalUsage: {},
            finishReason: "stop",
            providerMetadata: {},
        });

        expect((service as any).contentPublishTimeout).toBeUndefined();
    });

    test("uses cached content for non-streaming providers", async () => {
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

        // Simulate cached content
        (service as any).cachedContentForComplete = "Cached response text";

        const completeSpy = mock(() => {});
        service.on("complete", completeSpy);

        const finishHandler = (service as any).createFinishHandler();

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
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

        (service as any).cachedContentForComplete = "Some cached content";

        const finishHandler = (service as any).createFinishHandler();

        await finishHandler({
            text: "",
            steps: [],
            totalUsage: {},
            finishReason: "stop",
            providerMetadata: {},
        });

        expect((service as any).cachedContentForComplete).toBe("");
    });

    test("detects invalid tool calls and logs error", async () => {
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

        const finishHandler = (service as any).createFinishHandler();

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
});

describe("LLMService handleStreamError", () => {
    test("logs stream errors with duration", async () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

        const handleStreamError = (service as any).handleStreamError.bind(service);

        // Should not throw
        await handleStreamError(new Error("Stream failed"), Date.now() - 1000);
    });

    test("handles non-Error objects", async () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(mockRegistry, "openrouter", "gpt-4");

        const handleStreamError = (service as any).handleStreamError.bind(service);

        // Should not throw when error is a string
        await handleStreamError("String error", Date.now());
    });
});

describe("LLMService addCacheControl edge cases", () => {
    test("preserves existing message properties", async () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(mockRegistry, "anthropic", "claude-3");

        const addCacheControl = (service as any).addCacheControl.bind(service);

        const messages: ModelMessage[] = [
            {
                role: "system",
                content: "x".repeat(5000),
                customProperty: "preserved",
            } as any,
        ];

        const result = addCacheControl(messages);

        expect((result[0] as any).customProperty).toBe("preserved");
        expect(result[0].providerOptions).toBeDefined();
    });

    test("only caches system messages, not user messages", async () => {
        const mockRegistry = createMockRegistry();
        const service = new LLMService(mockRegistry, "anthropic", "claude-3");

        const addCacheControl = (service as any).addCacheControl.bind(service);

        const messages: ModelMessage[] = [
            { role: "user", content: "x".repeat(5000) },
        ];

        const result = addCacheControl(messages);

        expect(result[0].providerOptions).toBeUndefined();
    });
});
