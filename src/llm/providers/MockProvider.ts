import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3Content,
    LanguageModelV3FinishReason,
    LanguageModelV3StreamPart,
    LanguageModelV3Usage,
    ProviderV3,
} from "@ai-sdk/provider";
import { MockLLMService } from "@/test-utils/mock-llm/MockLLMService";
import type { MockLLMConfig, MockMessage, MockToolCall } from "@/test-utils/mock-llm/types";
import { logger } from "@/utils/logger";
import { MockLanguageModelV3 } from "ai/test";

const buildUsage = (inputTotal: number, outputTotal: number): LanguageModelV3Usage => ({
    inputTokens: {
        total: inputTotal,
        noCache: inputTotal,
        cacheRead: 0,
        cacheWrite: 0,
    },
    outputTokens: {
        total: outputTotal,
        text: outputTotal,
        reasoning: 0,
    },
});

const buildFinishReason = (hasToolCalls: boolean): LanguageModelV3FinishReason => ({
    unified: hasToolCalls ? "tool-calls" : "stop",
    raw: hasToolCalls ? "tool-calls" : "stop",
});

const formatToolInput = (toolCall: MockToolCall): string => {
    if (toolCall.params) {
        return JSON.stringify(toolCall.params);
    }

    if (typeof toolCall.args === "string") {
        return toolCall.args;
    }

    if (toolCall.args) {
        return JSON.stringify(toolCall.args);
    }

    return "{}";
};

const formatToolName = (toolCall: MockToolCall): string => {
    return toolCall.name ?? toolCall.function ?? "unknown";
};

const formatMessageContent = (
    content: LanguageModelV3CallOptions["prompt"][number]["content"]
): string => {
    if (typeof content === "string") {
        return content;
    }

    return content
        .map((part) => (part.type === "text" ? part.text : "[non-text content]"))
        .join(" ");
};

const toMockMessages = (prompt: LanguageModelV3CallOptions["prompt"]): MockMessage[] => {
    return prompt.map((message) => ({
        role: message.role,
        content: formatMessageContent(message.content),
    }));
};

/**
 * Creates a mock provider that integrates MockLLMService with AI SDK
 * This allows us to use the mock service through the standard LLMServiceFactory
 */
export function createMockProvider(config?: MockLLMConfig): ProviderV3 {
    const mockService = new MockLLMService(config);

    // Create a factory function that returns a language model
    const createLanguageModel = (modelId: string): LanguageModelV3 => {
        logger.info(`[MockProvider] Creating language model for: ${modelId}`);

        const doGenerate: LanguageModelV3["doGenerate"] = async (options) => {
            const messages = options.prompt;

            logger.debug("[MockProvider] doGenerate called", {
                messageCount: messages.length,
                toolCount: options.tools?.length ?? 0,
            });

            if (messages.length === 0) {
                logger.warn("[MockProvider] doGenerate called with no messages");
                return {
                    content: [
                        { type: "text", text: "Mock response: no messages provided" },
                    ],
                    finishReason: buildFinishReason(false),
                    usage: buildUsage(0, 0),
                    warnings: [],
                    response: {
                        id: `mock-${Date.now()}`,
                        timestamp: new Date(),
                        modelId,
                    },
                };
            }

            // Convert AI SDK messages to our Message format
            const convertedMessages = toMockMessages(messages);

            // Call MockLLMService
            const response = await mockService.complete({
                messages: convertedMessages,
                options: {
                    configName: modelId,
                },
            });

            const content: LanguageModelV3Content[] = [];

            // Add text content if present
            if (response.content) {
                content.push({ type: "text", text: response.content });
            }

            // Add tool calls if present
            if (response.toolCalls) {
                response.toolCalls.forEach((toolCall, index) => {
                    content.push({
                        type: "tool-call",
                        toolCallId: `call_${index}`,
                        toolName: formatToolName(toolCall),
                        input: formatToolInput(toolCall),
                    });
                });
            }

            return {
                content,
                finishReason: buildFinishReason(Boolean(response.toolCalls?.length)),
                usage: buildUsage(
                    response.usage?.prompt_tokens ?? 100,
                    response.usage?.completion_tokens ?? 50
                ),
                warnings: [],
                response: {
                    id: `mock-${Date.now()}`,
                    timestamp: new Date(),
                    modelId,
                },
            };
        };

        const doStream: LanguageModelV3["doStream"] = async (options) => {
            const messages = options.prompt;

            logger.debug("[MockProvider] doStream called", {
                messageCount: messages.length,
                toolCount: options.tools?.length ?? 0,
            });

            if (messages.length === 0) {
                logger.warn("[MockProvider] doStream called with no messages");
                const stream = new ReadableStream<LanguageModelV3StreamPart>({
                    start(controller) {
                        const textId = `text-${Date.now()}`;
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({ type: "text-start", id: textId });
                        controller.enqueue({
                            type: "text-delta",
                            id: textId,
                            delta: "Mock response: no messages provided",
                        });
                        controller.enqueue({ type: "text-end", id: textId });
                        controller.enqueue({
                            type: "finish",
                            finishReason: buildFinishReason(false),
                            usage: buildUsage(0, 0),
                        });
                        controller.close();
                    },
                });
                return {
                    stream,
                };
            }

            // Convert messages
            const convertedMessages = toMockMessages(messages);

            // Get the mock service's stream
            const streamEvents = mockService.stream({
                messages: convertedMessages,
                options: {
                    configName: modelId,
                },
            });

            // Create a ReadableStream that emits AI SDK v3 stream parts
            const stream = new ReadableStream<LanguageModelV3StreamPart>({
                async start(controller) {
                    let textId: string | null = null;
                    let sawToolCall = false;
                    let toolCallIndex = 0;

                    const ensureTextStart = (): void => {
                        if (!textId) {
                            textId = `text-${Date.now()}`;
                            controller.enqueue({ type: "text-start", id: textId });
                        }
                    };

                    controller.enqueue({ type: "stream-start", warnings: [] });

                    try {
                        for await (const event of streamEvents) {
                            switch (event.type) {
                                case "content":
                                    ensureTextStart();
                                    controller.enqueue({
                                        type: "text-delta",
                                        id: textId ?? "text-unknown",
                                        delta: event.content ?? "",
                                    });
                                    break;

                                case "tool_start": {
                                    if (!event.tool) break;
                                    sawToolCall = true;
                                    const toolCallId = `call_${toolCallIndex++}`;
                                    controller.enqueue({
                                        type: "tool-call",
                                        toolCallId,
                                        toolName: event.tool,
                                        input: JSON.stringify(event.args ?? {}),
                                    });
                                    break;
                                }

                                case "done": {
                                    if (textId) {
                                        controller.enqueue({ type: "text-end", id: textId });
                                    }
                                    controller.enqueue({
                                        type: "finish",
                                        finishReason: buildFinishReason(sawToolCall),
                                        usage: buildUsage(
                                            event.response?.usage?.prompt_tokens ?? 100,
                                            event.response?.usage?.completion_tokens ?? 50
                                        ),
                                    });
                                    break;
                                }

                                case "error": {
                                    controller.enqueue({
                                        type: "error",
                                        error: new Error(event.error ?? "Unknown error"),
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
                stream,
            };
        };

        return new MockLanguageModelV3({
            provider: "mock",
            modelId: modelId || "mock-model",
            doGenerate,
            doStream,
        });
    };

    // Create a custom provider that can handle any model ID
    const provider: ProviderV3 = {
        specificationVersion: "v3",
        languageModel: (modelId: string) => {
            return createLanguageModel(modelId);
        },
        embeddingModel: () => {
            throw new Error("Mock provider does not support embedding models");
        },
        imageModel: () => {
            throw new Error("Mock provider does not support image models");
        },
        transcriptionModel: () => {
            throw new Error("Mock provider does not support transcription models");
        },
        speechModel: () => {
            throw new Error("Mock provider does not support speech models");
        },
        rerankingModel: () => {
            throw new Error("Mock provider does not support reranking models");
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
