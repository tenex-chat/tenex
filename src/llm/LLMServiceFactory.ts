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
import { createMockProvider } from "./providers/MockProvider";
import type { ProviderStrategy } from "./providers/ProviderStrategy";
import { DefaultProviderStrategy } from "./providers/DefaultProviderStrategy";
import { ClaudeCodeProviderStrategy } from "./providers/ClaudeCodeProviderStrategy";

/**
 * Factory for creating LLM services with proper provider initialization
 */
export class LLMServiceFactory {
    private providers: Map<string, Provider> = new Map();
    private strategies: Map<string, ProviderStrategy> = new Map();
    private registry: ProviderRegistry | null = null;
    private initialized = false;

    /**
     * Initialize providers from configuration
     */
    initializeProviders(providerConfigs: Record<string, { apiKey: string }>): void {
        this.providers.clear();
        this.strategies.clear();

        // Set up default strategy for most providers
        const defaultStrategy = new DefaultProviderStrategy();

        // Check if mock mode is enabled
        if (process.env.USE_MOCK_LLM === 'true') {
            logger.debug("[LLMServiceFactory] Mock LLM mode enabled via USE_MOCK_LLM environment variable");

            // Load mock scenarios from file if specified
            const mockConfig = undefined;
            if (process.env.MOCK_LLM_SCENARIOS) {
                try {
                    // TODO: Load scenarios from file
                    logger.debug(`[LLMServiceFactory] Loading mock scenarios from: ${process.env.MOCK_LLM_SCENARIOS}`);
                } catch (error) {
                    logger.warn("[LLMServiceFactory] Failed to load mock scenarios, using defaults", {
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            this.providers.set("mock", createMockProvider(mockConfig));
            this.strategies.set("mock", defaultStrategy);

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
                        this.strategies.set(name, defaultStrategy);
                        logger.debug(`[LLMServiceFactory] Initialized OpenRouter provider`);
                        break;
                        
                    case "anthropic":
                        this.providers.set(name, createAnthropic({
                            apiKey: config.apiKey
                        }));
                        this.strategies.set(name, defaultStrategy);
                        logger.debug(`[LLMServiceFactory] Initialized Anthropic provider`);
                        break;

                    case "openai":
                        this.providers.set(name, createOpenAI({
                            apiKey: config.apiKey
                        }));
                        this.strategies.set(name, defaultStrategy);
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
                        this.strategies.set(name, defaultStrategy);
                        logger.debug(`[LLMServiceFactory] Initialized Ollama provider with baseURL: ${baseURL || 'default (http://localhost:11434)'}`);
                        break;
                    }
                    
                    case "claudeCode": {
                        // Claude Code requires runtime configuration with tools
                        // Only register the strategy, not the provider itself
                        this.strategies.set(name, new ClaudeCodeProviderStrategy());
                        logger.debug(`[LLMServiceFactory] Registered ClaudeCode strategy (runtime provider creation)`);
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
     * @param context Optional runtime context for providers that need it
     */
    createService(
        llmLogger: LLMLogger,
        config: LLMConfiguration,
        context?: {
            tools?: Record<string, AISdkTool>;
            agentName?: string;
        }
    ): LLMService {
        if (!this.initialized) {
            throw new Error("LLMServiceFactory not initialized. Call initializeProviders first.");
        }

        // If mock mode is enabled, always use mock provider regardless of config
        const actualProvider = process.env.USE_MOCK_LLM === 'true' ? 'mock' : config.provider;

        // Get the strategy for this provider
        const strategy = this.strategies.get(actualProvider);
        if (!strategy) {
            const available = Array.from(this.strategies.keys());
            throw new Error(
                `Provider "${actualProvider}" not available. ` +
                `Initialized providers: ${available.length > 0 ? available.join(", ") : "none"}`
            );
        }

        // Check if this provider requires runtime context but none was provided
        if (strategy.requiresRuntimeContext() && !context?.tools) {
            logger.warn(`[LLMServiceFactory] Provider ${actualProvider} requires runtime context but none provided`);
        }

        if (actualProvider === 'mock' && actualProvider !== config.provider) {
            logger.debug(`[LLMServiceFactory] Using mock provider instead of ${config.provider} due to USE_MOCK_LLM=true`);
        }

        // Use strategy to create the service
        return strategy.createService(
            llmLogger,
            { ...config, provider: actualProvider }, // Use actual provider in case of mock override
            this.registry!,
            context
        );
    }

    /**
     * Check if a provider is available
     */
    hasProvider(providerName: string): boolean {
        // Check strategies which includes all providers (including runtime ones like claudeCode)
        return this.strategies.has(providerName);
    }

    /**
     * Get list of available providers
     */
    getAvailableProviders(): string[] {
        // Return all strategies which includes runtime providers
        return Array.from(this.strategies.keys());
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