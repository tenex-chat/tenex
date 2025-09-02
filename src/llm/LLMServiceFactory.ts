import type { LLMLogger } from "@/logging/LLMLogger";
import type { LLMConfiguration } from "@/services/config/types";
import { logger } from "@/utils/logger";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createProviderRegistry, type Provider, type ProviderRegistry } from "ai";
import { LLMService } from "./service";

/**
 * Factory for creating LLM services with proper provider initialization
 */
export class LLMServiceFactory {
    private providers: Map<string, Provider> = new Map();
    private registry: ProviderRegistry | null = null;
    private initialized = false;

    /**
     * Initialize providers from configuration
     */
    initializeProviders(providerConfigs: Record<string, { apiKey: string }>): void {
        this.providers.clear();
        
        for (const [name, config] of Object.entries(providerConfigs)) {
            if (!config?.apiKey) {
                logger.debug(`[LLMServiceFactory] Skipping provider ${name} - no API key`);
                continue;
            }
            
            try {
                switch (name) {
                    case "openrouter":
                        this.providers.set(name, createOpenRouter({
                            apiKey: config.apiKey,
                            headers: {
                                "X-Title": "TENEX",
                                "HTTP-Referer": "https://github.com/pablof7z/tenex",
                            },
                        }));
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
        logger.info(`[LLMServiceFactory] Initialized ${this.providers.size} providers`);
    }

    /**
     * Create an LLM service from a resolved configuration
     */
    createService(
        llmLogger: LLMLogger,
        config: LLMConfiguration
    ): LLMService {
        if (!this.initialized || !this.registry) {
            throw new Error("LLMServiceFactory not initialized. Call initializeProviders first.");
        }

        // Verify the provider exists
        if (!this.providers.has(config.provider)) {
            const available = Array.from(this.providers.keys());
            throw new Error(
                `Provider "${config.provider}" not available. ` +
                `Initialized providers: ${available.length > 0 ? available.join(", ") : "none"}`
            );
        }

        // Use the shared registry for all services
        return new LLMService(
            llmLogger,
            this.registry,
            config.provider,
            config.model,
            config.temperature,
            config.maxTokens
        );
    }

    /**
     * Check if a provider is available
     */
    hasProvider(providerName: string): boolean {
        return this.providers.has(providerName);
    }

    /**
     * Get list of available providers
     */
    getAvailableProviders(): string[] {
        return Array.from(this.providers.keys());
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