import { configService } from "@/services";
import { logger } from "@/utils/logger";
import { igniteEngine, loadModels } from "multi-llm-ts";
import { ToolPlugin } from "./ToolPlugin";
import { getLLMLogger, initializeLLMLogger } from "./callLogger";
import type {
    CompletionRequest,
    CompletionResponse,
    ResolvedLLMConfig,
    LLMService,
    StreamEvent,
} from "./types";

export interface LLMRouterConfig {
    configs: Record<string, ResolvedLLMConfig>;
    defaults: {
        agents?: string;
        analyze?: string;
        orchestrator?: string;
        [key: string]: string | undefined;
    };
}

/**
 * Simple LLM router that manages multiple LLM instances
 */
export class LLMRouter implements LLMService {
    constructor(private config: LLMRouterConfig) {}

    /**
     * Resolve which configuration to use based on context
     */
    private resolveConfigKey(context?: { agentName?: string; configName?: string }): string {
        // Check if configName is a defaults reference (e.g., "defaults.analyze")
        if (context?.configName?.startsWith("defaults.")) {
            const defaultKey = context.configName.substring("defaults.".length);
            const configKey = this.config.defaults[defaultKey];
            if (configKey && this.config.configs[configKey]) {
                return configKey;
            }
            // If the default key doesn't exist or point to a valid config, continue to other logic
        }

        // Check if configName is a default key (e.g., "agents", "analyze", "orchestrator")
        if (context?.configName && this.config.defaults[context.configName]) {
            const configKey = this.config.defaults[context.configName];
            if (configKey && this.config.configs[configKey]) {
                return configKey;
            }
        }

        // Direct config name takes precedence
        if (context?.configName && this.config.configs[context.configName]) {
            return context.configName;
        }

        const key =
            this.config.defaults.agents ??
            this.config.defaults.analyze ??
            this.config.defaults.orchestrator ??
            Object.keys(this.config.configs)[0];

        // Fallback to first available config
        if (!key) {
            throw new Error("No LLM configurations available");
        }

        return key;
    }

    /**
     * Get available configuration keys
     */
    getConfigKeys(): string[] {
        return Object.keys(this.config.configs);
    }

    /**
     * Complete a request using the appropriate LLM
     */
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const startTime = Date.now();

        // Extract context from request options
        const context = {
            configName: request.options?.configName,
            agentName: request.options?.agentName,
        };

        // Get the configuration key
        const configKey = this.resolveConfigKey(context);
        const config = this.config.configs[configKey];

        if (!config) {
            throw new Error(`No LLM configuration found for key: ${configKey}`);
        }

        // Trace system prompt if present
        const systemMessage = request.messages.find((m) => m.role === "system");
        if (systemMessage) {
            logger.debug("[LLM] System prompt", {
                configKey,
                systemPrompt: systemMessage.content,
                length: systemMessage.content.length,
            });
        }

        // Trace all messages
        logger.debug("[LLM] Request messages", {
            configKey,
            messages: request.messages.map((msg, index) => ({
                index,
                role: msg.role,
                contentLength: msg.content.length,
                contentPreview:
                    msg.content.substring(0, 200) + (msg.content.length > 200 ? "..." : ""),
            })),
        });

        let response: CompletionResponse | undefined;
        let error: Error | undefined;

        try {
            // Use the multi-llm-ts v4 API
            const llmConfig = {
                apiKey: config.apiKey,
                baseURL: config.baseUrl,
            };

            const llm = igniteEngine(config.provider, llmConfig);

            // Register tools as plugins if provided
            if (request.tools && request.toolContext) {
                for (const tool of request.tools) {
                    llm.addPlugin(new ToolPlugin(tool, request.toolContext));
                }
            }

            const models = await loadModels(config.provider, llmConfig);

            if (!models || !models.chat || models.chat.length === 0) {
                throw new Error(`No models available for provider ${config.provider}`);
            }

            // Find the specific model - handle both string and ChatModel types
            const model =
                models.chat.find((m) => {
                    const modelId = typeof m === "string" ? m : m.id;
                    return modelId === config.model;
                }) || models.chat[0];
            if (!model) {
                throw new Error(`Model ${config.model} not found for provider ${config.provider}`);
            }

            // Execute completion with API
            response = await llm.complete(model, request.messages, {
                usage: true,
                caching: true,
            });

            // Add model information to the response
            // The response from multi-llm-ts doesn't include the model, so we add it
            response = {
                ...response,
                model: config.model
            } as CompletionResponse & { model: string };

            const endTime = Date.now();

            // Trace response content
            if (response.content) {
                logger.debug("[LLM] Response content", {
                    configKey,
                    content: response.content,
                    contentLength: response.content.length,
                });
            }

            // Trace tool calls if present
            if (response.toolCalls?.length) {
                logger.debug("[LLM] Tool calls", {
                    configKey,
                    toolCalls: response.toolCalls.map((tc) => ({
                        name: tc.name,
                        paramsLength: JSON.stringify(tc.params).length,
                    })),
                });
            }

            // Log to comprehensive JSONL logger
            const llmLogger = getLLMLogger();
            if (llmLogger) {
                await llmLogger.logLLMCall(
                    configKey,
                    config,
                    request,
                    { response },
                    { startTime, endTime }
                );
            }

            return response;
        } catch (caughtError) {
            const endTime = Date.now();
            const duration = endTime - startTime;
            error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

            logger.error("[LLM] Completion failed", {
                configKey,
                duration: `${duration}ms`,
                error: error.message,
                stack: error.stack,
            });

            // Log to comprehensive JSONL logger
            const llmLogger = getLLMLogger();
            if (llmLogger) {
                await llmLogger.logLLMCall(
                    configKey,
                    config,
                    request,
                    { error },
                    { startTime, endTime }
                );
            }

            throw error;
        }
    }

    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
        const configKey = this.resolveConfigKey(request.options);
        const config = this.config.configs[configKey];
        if (!config) {
            throw new Error(`LLM configuration not found: ${configKey}`);
        }

        const startTime = Date.now();

        try {
            const llmConfig = {
                apiKey: config.apiKey,
                baseURL: config.baseUrl,
            };

            const llm = igniteEngine(config.provider, llmConfig);

            // Register tools as plugins if provided
            if (request.tools && request.toolContext) {
                for (const tool of request.tools) {
                    llm.addPlugin(new ToolPlugin(tool, request.toolContext));
                }
            }

            const models = await loadModels(config.provider, llmConfig);

            if (!models || !models.chat || models.chat.length === 0) {
                throw new Error(`No models available for provider ${config.provider}`);
            }

            // Find the specific model
            const model =
                models.chat.find((m) => {
                    const modelId = typeof m === "string" ? m : m.id;
                    return modelId === config.model;
                }) || models.chat[0];
            if (!model) {
                throw new Error(`Model ${config.model} not found for provider ${config.provider}`);
            }

            // Use generate() for streaming
            const stream = llm.generate(model, request.messages, {
                usage: true,
                caching: config.enableCaching ?? true,
            });

            let fullContent = "";
            let lastResponse: CompletionResponse | undefined;
            const chunkMetadata: Array<{ type: string; chunkKeys: string[]; fullChunk: string }> = [];

            for await (const chunk of stream) {
                // Log chunk metadata
                const chunkInfo = {
                    type: chunk.type,
                    chunkKeys: Object.keys(chunk),
                    fullChunk: JSON.stringify(chunk),
                };
                chunkMetadata.push(chunkInfo);

                if (chunk.type === "content" || chunk.type === "reasoning") {
                    fullContent += chunk.text;
                    yield { type: "content", content: chunk.text };
                } else if (chunk.type === "tool") {
                    if (chunk.status === "calling" && chunk.call?.params !== undefined) {
                        // Normalize empty string to empty object for tools with no arguments
                        let normalizedParams = chunk.call.params;
                        if (normalizedParams === "") {
                            normalizedParams = {};
                        }
                        yield {
                            type: "tool_start",
                            tool: chunk.name,
                            args: normalizedParams,
                        };
                    } else if (chunk.done && chunk.call?.result !== undefined) {
                        yield {
                            type: "tool_complete",
                            tool: chunk.name,
                            result: chunk.call.result,
                        };
                    }
                } else if (chunk.type === "usage") {
                    // Build the final response with model information
                    lastResponse = {
                        type: "text",
                        content: fullContent,
                        usage: chunk.usage,
                        toolCalls: [],
                        model: config.model
                    } as CompletionResponse & { model: string };
                }
            }

            const endTime = Date.now();

            if (lastResponse) {
                // Log to comprehensive JSONL logger
                const llmLogger = getLLMLogger();
                if (llmLogger) {
                    await llmLogger.logLLMCall(
                        configKey,
                        config,
                        request,
                        { response: lastResponse },
                        { startTime, endTime }
                    );
                }

                yield { type: "done", response: lastResponse };
            }
        } catch (error) {
            const endTime = Date.now();
            const duration = endTime - startTime;
            const errorObj = error instanceof Error ? error : new Error(String(error));

            logger.error("[LLM] Streaming failed", {
                configKey,
                duration: `${duration}ms`,
                error: errorObj.message,
                stack: errorObj.stack,
            });

            // Log to comprehensive JSONL logger
            const llmLogger = getLLMLogger();
            if (llmLogger) {
                await llmLogger.logLLMCall(
                    configKey,
                    config,
                    request,
                    { error: errorObj },
                    { startTime, endTime }
                );
            }

            yield { type: "error", error: errorObj.message };
        }
    }
}

/**
 * Load LLM router from configuration file
 */
export async function loadLLMRouter(projectPath: string): Promise<LLMRouter> {
    try {
        // Initialize comprehensive LLM logger
        initializeLLMLogger(projectPath);

        // Use configService to load merged global and project-specific configuration
        const { llms: tenexLLMs } = await configService.loadConfig(projectPath);

        // Transform TenexLLMs structure to LLMRouterConfig with resolved configs
        const configs: Record<string, ResolvedLLMConfig> = {};

        // For each configuration, merge in the credentials to create resolved configs
        for (const [name, config] of Object.entries(tenexLLMs.configurations)) {
            const provider = config.provider;
            const credentials = tenexLLMs.credentials?.[provider] || {};

            configs[name] = {
                ...config,
                apiKey: credentials.apiKey,
                baseUrl: credentials.baseUrl,
                headers: credentials.headers,
            };
        }

        const routerConfig: LLMRouterConfig = {
            configs,
            defaults: tenexLLMs.defaults || { agents: undefined, analyze: undefined },
        };

        return new LLMRouter(routerConfig);
    } catch (error) {
        logger.error("Failed to load LLM configuration:", error);
        throw error;
    }
}

/**
 * Create an agent-aware LLM service that automatically routes based on agent
 */
export function createAgentAwareLLMService(router: LLMRouter, agentName: string): LLMService {
    return {
        complete: async (request: CompletionRequest) => {
            // Inject agent name into options
            const enhancedRequest = {
                ...request,
                options: {
                    ...request.options,
                    agentName,
                },
            };
            return router.complete(enhancedRequest);
        },
        stream: async function* (request: CompletionRequest) {
            // Inject agent name into options
            const enhancedRequest = {
                ...request,
                options: {
                    ...request.options,
                    agentName,
                },
            };
            yield* router.stream(enhancedRequest);
        },
    };
}
