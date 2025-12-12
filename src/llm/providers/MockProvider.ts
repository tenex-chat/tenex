import { MockLLMService } from "@/test-utils/mock-llm/MockLLMService";
import type { MockLLMConfig } from "@/test-utils/mock-llm/types";
import { logger } from "@/utils/logger";
import type {
    LanguageModelV2,
    LanguageModelV2CallOptions,
    LanguageModelV2CallWarning,
    LanguageModelV2Content,
    LanguageModelV2FinishReason,
    LanguageModelV2Message,
    LanguageModelV2StreamPart,
    ProviderV2,
} from "@ai-sdk/provider";
import { MockLanguageModelV2 } from "ai/test";

/**
 * Creates a mock provider that integrates MockLLMService with AI SDK
 * This allows us to use the mock service through the standard LLMServiceFactory
 */
export function createMockProvider(config?: MockLLMConfig): ProviderV2 {
    const mockService = new MockLLMService(config);

    // Create a factory function that returns a language model
    const createLanguageModel = (modelId: string): LanguageModelV2 => {
        logger.info(`[MockProvider] Creating language model for: ${modelId}`);

        return new MockLanguageModelV2({
            provider: "mock",
            modelId: modelId || "mock-model",

            doGenerate: (async (options: LanguageModelV2CallOptions) => {
                // Extract messages from prompt
                const messages = options.prompt;

                logger.debug("[MockProvider] doGenerate called", {
                    messageCount: messages?.length || 0,
                    toolCount: Object.keys(options?.tools || {}).length,
                });

                if (!messages || messages.length === 0) {
                    logger.warn("[MockProvider] doGenerate called with no messages");
                    return {
                        content: [{ type: "text" as const, text: "Mock response: no messages provided" }],
                        finishReason: "stop" as LanguageModelV2FinishReason,
                        usage: { inputTokens: 0, outputTokens: 0 },
                        warnings: [] as LanguageModelV2CallWarning[],
                        response: {
                            id: `mock-${Date.now()}`,
                            timestamp: new Date(),
                            modelId,
                        },
                    };
                }

                // Convert AI SDK messages to our Message format
                const convertedMessages = messages.map((msg: LanguageModelV2Message) => {
                    let textContent = "";
                    if (Array.isArray(msg.content)) {
                        textContent = msg.content
                            .map((part) => {
                                if (part.type === "text") return part.text;
                                return "[non-text content]";
                            })
                            .join(" ");
                    } else if (typeof msg.content === "string") {
                        textContent = msg.content;
                    }
                    return {
                        role: msg.role,
                        content: textContent,
                    };
                });

                // Call MockLLMService
                const response = await mockService.complete({
                    messages: convertedMessages,
                    options: {
                        configName: modelId,
                    },
                });

                // Convert response to AI SDK v2 format with content array
                const content: LanguageModelV2Content[] = [];

                // Add text content if present
                if (response.content) {
                    content.push({ type: "text" as const, text: response.content });
                }

                // Add tool calls if present
                if (response.toolCalls) {
                    response.toolCalls.forEach((tc: any, index: number) => {
                        content.push({
                            type: "tool-call" as const,
                            toolCallId: `call_${index}`,
                            toolName: tc.name,
                            input: JSON.stringify(tc.params || {}),
                        });
                    });
                }

                return {
                    content,
                    finishReason: "stop" as LanguageModelV2FinishReason,
                    usage: {
                        inputTokens: response.usage?.prompt_tokens || 100,
                        outputTokens: response.usage?.completion_tokens || 50,
                    },
                    warnings: [] as LanguageModelV2CallWarning[],
                    response: {
                        id: `mock-${Date.now()}`,
                        timestamp: new Date(),
                        modelId,
                    },
                };
            }) as unknown as LanguageModelV2["doGenerate"],

            doStream: (async (options: LanguageModelV2CallOptions) => {
                // Extract messages from prompt
                const messages = options.prompt;

                logger.debug("[MockProvider] doStream called", {
                    messageCount: messages?.length || 0,
                    toolCount: Object.keys(options?.tools || {}).length,
                });

                if (!messages || messages.length === 0) {
                    logger.warn("[MockProvider] doStream called with no messages");
                    const stream = new ReadableStream({
                        start(controller) {
                            controller.enqueue({
                                type: "text-delta",
                                delta: "Mock response: no messages provided",
                            });
                            controller.enqueue({
                                type: "finish",
                                finishReason: "stop",
                                usage: { inputTokens: 0, outputTokens: 0 },
                                logprobs: undefined,
                            });
                            controller.close();
                        },
                    });
                    return {
                        stream: stream as ReadableStream<LanguageModelV2StreamPart>,
                        warnings: [] as LanguageModelV2CallWarning[],
                        response: {
                            id: `mock-stream-${Date.now()}`,
                            timestamp: new Date(),
                            modelId,
                        },
                    };
                }

                // Convert messages
                const convertedMessages = messages.map((msg: LanguageModelV2Message) => {
                    let textContent = "";
                    if (Array.isArray(msg.content)) {
                        textContent = msg.content
                            .map((part) => {
                                if (part.type === "text") return part.text;
                                return "[non-text content]";
                            })
                            .join(" ");
                    } else if (typeof msg.content === "string") {
                        textContent = msg.content;
                    }
                    return {
                        role: msg.role,
                        content: textContent,
                    };
                });

                // Get the mock service's stream
                const streamEvents = mockService.stream({
                    messages: convertedMessages,
                    options: {
                        configName: modelId,
                    },
                });

                // Create a ReadableStream that emits AI SDK v2 stream parts
                const stream = new ReadableStream({
                    async start(controller) {
                        try {
                            const toolCalls: Array<{
                                toolCallId: string;
                                toolName: string;
                                arguments: unknown;
                            }> = [];

                            for await (const event of streamEvents) {
                                switch (event.type) {
                                    case "content":
                                        controller.enqueue({
                                            type: "text-delta",
                                            delta: event.content,
                                        });
                                        break;

                                    case "tool_start": {
                                        if (!event.tool) break;
                                        const toolCallId = `call_${toolCalls.length}`;
                                        const toolCall = {
                                            toolCallId,
                                            toolName: event.tool,
                                            arguments: event.args,
                                        };
                                        toolCalls.push(toolCall);

                                        controller.enqueue({
                                            type: "tool-call-delta",
                                            toolCallType: "function" as const,
                                            toolCallId,
                                            toolName: event.tool,
                                            argsTextDelta: JSON.stringify(event.args),
                                        });
                                        break;
                                    }

                                    case "done": {
                                        controller.enqueue({
                                            type: "finish",
                                            finishReason: "stop",
                                            usage: {
                                                inputTokens:
                                                    event.response?.usage?.prompt_tokens || 100,
                                                outputTokens:
                                                    event.response?.usage?.completion_tokens || 50,
                                            },
                                            logprobs: undefined,
                                        });
                                        break;
                                    }

                                    case "error": {
                                        controller.enqueue({
                                            type: "error",
                                            error: new Error(event.error),
                                        });
                                        break;
                                    }
                                }
                            }

                            controller.close();
                        } catch (error) {
                            controller.error(error);
                        }
                    },
                });

                return {
                    stream: stream as ReadableStream<LanguageModelV2StreamPart>,
                    warnings: [] as LanguageModelV2CallWarning[],
                    response: {
                        id: `mock-stream-${Date.now()}`,
                        timestamp: new Date(),
                        modelId,
                    },
                };
            }) as LanguageModelV2["doStream"],
        });
    };

    // Create a custom provider that can handle any model ID
    const provider: ProviderV2 = {
        languageModel: (modelId: string) => {
            return createLanguageModel(modelId);
        },
        textEmbeddingModel: () => {
            throw new Error("Mock provider does not support embedding models");
        },
        imageModel: () => {
            throw new Error("Mock provider does not support image models");
        },
    };

    return provider;
}

/**
 * Global mock service instance for test configuration
 */
let globalMockService: MockLLMService | null = null;

/**
 * Get or create the global mock service
 */
export function getGlobalMockService(config?: MockLLMConfig): MockLLMService {
    if (!globalMockService) {
        globalMockService = new MockLLMService(config);
    }
    return globalMockService;
}

/**
 * Reset the global mock service
 */
export function resetGlobalMockService(): void {
    globalMockService = null;
}
