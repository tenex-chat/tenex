import type { MockLLMConfig } from "@/test-utils/mock-llm/types";
import { MockLLMService } from "@/test-utils/mock-llm/MockLLMService";
import { logger } from "@/utils/logger";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Provider } from "ai";

/**
 * Creates a mock provider that integrates MockLLMService with AI SDK
 * This allows us to use the mock service through the standard LLMServiceFactory
 */
export function createMockProvider(config?: MockLLMConfig): Provider {
    const mockService = new MockLLMService(config);
    
    // Create a factory function that returns a language model
    const createLanguageModel = (modelId: string): LanguageModelV3 => {
        logger.info(`[MockProvider] Creating language model for: ${modelId}`);

        return new MockLanguageModelV3({
            provider: "mock",
            modelId: modelId || "mock-model",
            
            doGenerate: async (options) => {
                // Extract messages - the prompt can be either an array or an object with messages
                const messages = Array.isArray(options?.prompt) 
                    ? options.prompt 
                    : options?.prompt?.messages;
                
                logger.debug("[MockProvider] doGenerate called", {
                    hasPrompt: !!options?.prompt,
                    messageCount: messages?.length || 0,
                    toolCount: Object.keys(options?.tools || {}).length,
                });
                
                if (!messages || messages.length === 0) {
                    logger.warn("[MockProvider] doGenerate called with no messages");
                    return {
                        finishReason: "stop" as const,
                        usage: { inputTokens: 0, outputTokens: 0 },
                        text: "Mock response: no messages provided",
                        toolCalls: [],
                        warnings: [],
                        logprobs: undefined,
                        response: {
                            id: `mock-${Date.now()}`,
                            timestamp: new Date(),
                            modelId,
                        },
                    };
                }

                // Convert AI SDK messages to our Message format
                const convertedMessages = messages.map(msg => ({
                    role: msg.role,
                    content: Array.isArray(msg.content) 
                        ? msg.content.map(part => {
                            if (part.type === "text") return part.text;
                            return "[non-text content]";
                        }).join(" ")
                        : typeof msg.content === "string" ? msg.content : "",
                }));

                // Call MockLLMService
                const response = await mockService.complete({
                    messages: convertedMessages,
                    options: {
                        configName: modelId,
                    },
                });

                // Convert response to AI SDK v2 format
                const text = response.content || "";
                const toolCalls = response.toolCalls?.map((tc, index) => ({
                    toolCallType: "function" as const,
                    toolCallId: `call_${index}`,
                    toolName: tc.name,
                    arguments: tc.params || {},
                })) || [];

                return {
                    finishReason: "stop" as const,
                    usage: {
                        inputTokens: response.usage?.prompt_tokens || 100,
                        outputTokens: response.usage?.completion_tokens || 50,
                    },
                    text,
                    toolCalls,
                    warnings: [],
                    logprobs: undefined,
                    response: {
                        id: `mock-${Date.now()}`,
                        timestamp: new Date(),
                        modelId,
                    },
                };
            },
            
            doStream: async (options) => {
                // Extract messages - the prompt can be either an array or an object with messages
                const messages = Array.isArray(options?.prompt) 
                    ? options.prompt 
                    : options?.prompt?.messages;
                
                logger.debug("[MockProvider] doStream called", {
                    hasPrompt: !!options?.prompt,
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
                        stream,
                        warnings: [],
                        response: {
                            id: `mock-stream-${Date.now()}`,
                            timestamp: new Date(),
                            modelId,
                        },
                    };
                }

                // Convert messages
                const convertedMessages = messages.map(msg => ({
                    role: msg.role,
                    content: Array.isArray(msg.content) 
                        ? msg.content.map(part => {
                            if (part.type === "text") return part.text;
                            return "[non-text content]";
                        }).join(" ")
                        : typeof msg.content === "string" ? msg.content : "",
                }));

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
                                                inputTokens: event.response?.usage?.prompt_tokens || 100,
                                                outputTokens: event.response?.usage?.completion_tokens || 50,
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
                    stream,
                    warnings: [],
                    response: {
                        id: `mock-stream-${Date.now()}`,
                        timestamp: new Date(),
                        modelId,
                    },
                };
            },
        });
    };
    
    // Create a custom provider that can handle any model ID
    const provider: Provider = {
        languageModel: (modelId: string) => {
            return createLanguageModel(modelId);
        },
        textEmbeddingModel: () => {
            throw new Error("Mock provider does not support embedding models");
        },
        // Provider type from 'ai' package may have slightly different interface
        // Cast as needed
    } as Provider;
    
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