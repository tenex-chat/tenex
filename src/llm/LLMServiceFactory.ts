import type { LLMLogger } from "@/logging/LLMLogger";
import type { LLMConfiguration } from "@/services/config/types";
import type { AISdkTool } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";
import { createProviderRegistry, type Provider, type ProviderRegistry } from "ai";
import { LLMService } from "./service";
import { createClaudeCode, type ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { PermissionMode } from "@anthropic-ai/claude-code";
import { TenexToolsAdapter } from "./providers/TenexToolsAdapter";

/**
 * Factory for creating LLM services with proper provider initialization
 */
export class LLMServiceFactory {
    private providers: Map<string, Provider> = new Map();
    private registry: ProviderRegistry | null = null;
    private claudeCodeApiKey: string | null = null; // Store Claude Code API key for runtime use
    private initialized = false;

    /**
     * Initialize providers from configuration
     */
    async initializeProviders(providerConfigs: Record<string, { apiKey: string }>): Promise<void> {
        this.providers.clear();
        this.claudeCodeApiKey = null;

        // Check if mock mode is enabled
        if (process.env.USE_MOCK_LLM === 'true') {
            logger.debug("[LLMServiceFactory] Mock LLM mode enabled via USE_MOCK_LLM environment variable");

            // Dynamically import MockProvider only when needed to avoid loading test dependencies
            try {
                const { createMockProvider } = await import("./providers/MockProvider");
                this.providers.set("mock", createMockProvider());
            } catch (error) {
                logger.error("[LLMServiceFactory] Failed to load MockProvider:", error);
                throw new Error("Mock mode is enabled but MockProvider could not be loaded. Make sure test dependencies are installed.");
            }

            // In mock mode, we only use the mock provider
            // Other providers can still be initialized but won't be used by default
        }
        
        for (const [name, config] of Object.entries(providerConfigs)) {
            if (!config?.apiKey) {
                logger.debug(`[LLMServiceFactory] Skipping provider ${name} - no API key`);
                continue;
            }
            
            try {
                switch (name) {
                    case "openrouter":
                        this.providers.set(
                            name,
                            createOpenRouter({
                                apiKey: config.apiKey,
                                usage: { include: true },
                                headers: {
                                    "X-Title": "TENEX",
                                    "HTTP-Referer": "https://github.com/tenex-chat/tenex",
                                },
                            })
                        );
                        logger.debug(`[LLMServiceFactory] Initialized OpenRouter provider`);
                        break;
                        
                    case "anthropic":
                        this.providers.set(name, createAnthropic({
                            apiKey: config.apiKey
                        }));
                        logger.debug(`[LLMServiceFactory] Initialized Anthropic provider`);
                        break;

                    case "openai":
                        this.providers.set(name, createOpenAI({
                            apiKey: config.apiKey
                        }));
                        logger.debug(`[LLMServiceFactory] Initialized OpenAI provider`);
                        break;
                        
                    case "ollama": {
                        // For Ollama, apiKey is actually the base URL
                        // The library expects the URL to include /api path
                        let baseURL: string | undefined;
                        if (config.apiKey === "local") {
                            // Use default (library provides http://127.0.0.1:11434/api)
                            baseURL = undefined;
                        } else {
                            // Custom URL - ensure it ends with /api
                            baseURL = config.apiKey.endsWith('/api') 
                                ? config.apiKey 
                                : config.apiKey.replace(/\/$/, '') + '/api';
                        }
                        
                        // Create Ollama provider with custom base URL if provided
                        const ollamaProvider = createOllama(baseURL ? { baseURL } : undefined);

                        this.providers.set(name, ollamaProvider as Provider);
                        logger.debug(`[LLMServiceFactory] Initialized Ollama provider with baseURL: ${baseURL || 'default (http://localhost:11434)'}`);
                        break;
                    }
                    
                    case "claudeCode": {
                        // Store API key for runtime Claude Code creation
                        this.claudeCodeApiKey = config.apiKey;
                        logger.debug(`[LLMServiceFactory] Stored Claude Code API key for runtime use`);
                        break;
                    }
                        
                    default:
                        logger.warn(`[LLMServiceFactory] Unknown provider type: ${name}`);
                }
            } catch (error) {
                logger.error(`[LLMServiceFactory] Failed to initialize provider ${name}`, {
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
        
        // Create the provider registry with all configured providers
        if (this.providers.size > 0) {
            const providerObject: Record<string, Provider> = {};
            for (const [name, provider] of this.providers.entries()) {
                providerObject[name] = provider;
            }
            this.registry = createProviderRegistry(providerObject);
            logger.debug(`[LLMServiceFactory] Created provider registry with ${this.providers.size} providers`);
        } else {
            logger.warn(`[LLMServiceFactory] No providers were successfully initialized`);
            // Create an empty registry to avoid null checks everywhere
            this.registry = createProviderRegistry({});
        }
        
        this.initialized = true;
    }

    /**
     * Create an LLM service from a resolved configuration
     * @param llmLogger Logger for the service
     * @param config LLM configuration
     * @param context Optional runtime context for Claude Code
     */
    createService(
        llmLogger: LLMLogger,
        config: LLMConfiguration,
        context?: {
            tools?: Record<string, AISdkTool>;
            agentName?: string;
            sessionId?: string;
        }
    ): LLMService {
        if (!this.initialized) {
            throw new Error("LLMServiceFactory not initialized. Call initializeProviders first.");
        }

        // Convert agent name to slug format for logging
        const agentSlug = context?.agentName
            ? context.agentName.toLowerCase().replace(/\s+/g, '-')
            : undefined;

        // If mock mode is enabled, always use mock provider regardless of config
        const actualProvider = process.env.USE_MOCK_LLM === 'true' ? 'mock' : config.provider;

        if (actualProvider === 'mock' && actualProvider !== config.provider) {
            logger.debug(`[LLMServiceFactory] Using mock provider instead of ${config.provider} due to USE_MOCK_LLM=true`);
        }

        // Handle Claude Code provider specially
        if (actualProvider === 'claudeCode') {
            if (!this.claudeCodeApiKey) {
                throw new Error("Claude Code API key not configured");
            }

            // Extract tool names from the provided tools
            const toolNames = context?.tools ? Object.keys(context.tools) : [];
            const regularTools = toolNames.filter(name => !name.startsWith('mcp__'));

            logger.info("[LLMServiceFactory] 🚀 CREATING CLAUDE CODE PROVIDER", {
                agent: context?.agentName,
                agentSlug,
                sessionId: context?.sessionId || 'NONE',
                hasSessionId: !!context?.sessionId,
                regularTools,
                toolCount: regularTools.length
            });

            // Create SDK MCP server for local TENEX tools if any exist
            const tenexSdkServer = regularTools.length > 0 && context?.tools
                ? TenexToolsAdapter.createSdkMcpServer(context.tools, context)
                : undefined;

            // Build mcpServers configuration
            const mcpServersConfig: Record<string, unknown> = {};
            if (tenexSdkServer) {
                mcpServersConfig.tenex = tenexSdkServer;
            }

            // Build allowed tools list
            const allowedTools = tenexSdkServer
                ? regularTools.map(name => `mcp__tenex__${name}`)
                : [];

            // Create Claude Code provider with runtime configuration
            const claudeCodeConfig = {
                defaultSettings: {
                    permissionMode: "bypassPermissions" as PermissionMode,
                },
                mcpServers: mcpServersConfig,
                allowedTools: allowedTools,
                logger: {
                    warn: (message: string) => logger.warn("[ClaudeCode]", message),
                    error: (message: string) => logger.error("[ClaudeCode]", message),
                },
            };

            // Create the provider function that can accept resume parameter
            const providerFunction = (model: string, options?: ClaudeCodeSettings): ReturnType<ReturnType<typeof createClaudeCode>> => {
                return createClaudeCode(claudeCodeConfig)(model, options);
            };

            return new LLMService(
                llmLogger,
                null,
                'claudeCode',
                config.model,
                config.temperature,
                config.maxTokens,
                providerFunction,
                context?.sessionId,
                agentSlug,
                context?.progressMonitor
            );
        }

        // For standard providers, check if provider is available
        if (!this.providers.has(actualProvider)) {
            const available = Array.from(this.providers.keys());
            throw new Error(
                `Provider "${actualProvider}" not available. ` +
                `Initialized providers: ${available.length > 0 ? available.join(", ") : "none"}`
            );
        }

        // Return standard LLMService with registry
        if (!this.registry) {
            throw new Error("Provider registry not initialized");
        }

        return new LLMService(
            llmLogger,
            this.registry,
            actualProvider,
            config.model,
            config.temperature,
            config.maxTokens,
            undefined,
            undefined,
            agentSlug,
            context?.progressMonitor
        );
    }

    /**
     * Check if a provider is available
     */
    hasProvider(providerName: string): boolean {
        // Check standard providers or Claude Code
        return this.providers.has(providerName) || (providerName === 'claudeCode' && !!this.claudeCodeApiKey);
    }

    /**
     * Get list of available providers
     */
    getAvailableProviders(): string[] {
        const providers = Array.from(this.providers.keys());
        if (this.claudeCodeApiKey) {
            providers.push('claudeCode');
        }
        return providers;
    }

    /**
     * Get the provider registry
     * Useful for direct access to language models
     */
    getRegistry(): ProviderRegistry {
        if (!this.registry) {
            throw new Error("LLMServiceFactory not initialized. Call initializeProviders first.");
        }
        return this.registry;
    }

    /**
     * Reset the factory (mainly for testing)
     */
    reset(): void {
        this.providers.clear();
        this.registry = null;
        this.initialized = false;
    }
}

// Export singleton instance
export const llmServiceFactory = new LLMServiceFactory();