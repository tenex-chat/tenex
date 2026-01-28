/**
 * Provider Registry - Central registry for all LLM providers
 *
 * This module provides a unified registry for managing LLM providers,
 * supporting both standard AI SDK providers and custom agent providers.
 */

import { createProviderRegistry } from "ai";
import type { ProviderRegistryProvider } from "ai";
import { logger } from "@/utils/logger";
import type {
    ILLMProvider,
    ProviderInitConfig,
    ProviderMetadata,
    ProviderRegistration,
    ProviderRuntimeContext,
    ProviderModelResult,
} from "../types";

/**
 * Provider initialization result
 */
interface InitializationResult {
    providerId: string;
    success: boolean;
    error?: string;
}

/**
 * Central registry for all LLM providers
 *
 * The registry manages provider lifecycle:
 * 1. Registration - Providers register themselves
 * 2. Initialization - Providers are initialized with API keys
 * 3. Model Creation - Providers create language models on demand
 */
export class ProviderRegistry {
    private static instance: ProviderRegistry | null = null;

    private providers: Map<string, ILLMProvider> = new Map();
    private registrations: Map<string, ProviderRegistration> = new Map();
    private aiSdkRegistry: ProviderRegistryProvider | null = null;
    private initialized = false;

    /**
     * Get the singleton instance
     */
    static getInstance(): ProviderRegistry {
        if (!ProviderRegistry.instance) {
            ProviderRegistry.instance = new ProviderRegistry();
        }
        return ProviderRegistry.instance;
    }

    /**
     * Reset the singleton (for testing)
     */
    static resetInstance(): void {
        if (ProviderRegistry.instance) {
            ProviderRegistry.instance.reset();
            ProviderRegistry.instance = null;
        }
    }

    /**
     * Register a provider class
     * This should be called during module initialization
     */
    register(registration: ProviderRegistration): void {
        const { metadata } = registration;

        if (this.registrations.has(metadata.id)) {
            logger.warn(`[ProviderRegistry] Provider "${metadata.id}" already registered, skipping`);
            return;
        }

        this.registrations.set(metadata.id, registration);
        logger.debug(`[ProviderRegistry] Registered provider: ${metadata.id}`);
    }

    /**
     * Register multiple providers at once
     */
    registerAll(registrations: ProviderRegistration[]): void {
        for (const reg of registrations) {
            this.register(reg);
        }
    }

    /**
     * Initialize all registered providers with their configurations
     */
    async initialize(
        configs: Record<string, ProviderInitConfig>,
        _options?: { enableTenexTools?: boolean }
    ): Promise<InitializationResult[]> {
        const results: InitializationResult[] = [];
        this.providers.clear();

        // Check if mock mode is enabled
        if (process.env.USE_MOCK_LLM === "true") {
            await this.initializeMockProvider();
        }

        // Initialize each registered provider that has a config
        for (const [providerId, registration] of this.registrations) {
            const config = configs[providerId];

            // Skip providers without config (unless they don't require API key)
            if (!config?.apiKey && registration.metadata.capabilities.requiresApiKey) {
                continue;
            }

            try {
                const provider = new registration.Provider();
                await provider.initialize(config || {});
                this.providers.set(providerId, provider);

                results.push({ providerId, success: true });

                logger.debug(`[ProviderRegistry] Initialized provider: ${providerId}`);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                results.push({ providerId, success: false, error: errorMessage });

                logger.error(`[ProviderRegistry] Failed to initialize provider ${providerId}`, {
                    error: errorMessage,
                });
            }
        }

        // Build the AI SDK registry from standard providers
        this.buildAiSdkRegistry();

        this.initialized = true;

        logger.debug(`[ProviderRegistry] Initialized ${this.providers.size} providers: ${Array.from(this.providers.keys()).join(", ")}`);

        return results;
    }

    /**
     * Initialize the mock provider for testing
     */
    private async initializeMockProvider(): Promise<void> {
        try {
            const { createMockProvider } = await import("../MockProvider");
            const mockProvider = createMockProvider();

            // Create a wrapper that satisfies ILLMProvider
            const mockWrapper: ILLMProvider = {
                metadata: {
                    id: "mock",
                    displayName: "Mock Provider",
                    description: "Mock provider for testing",
                    category: "standard",
                    capabilities: {
                        streaming: true,
                        toolCalling: true,
                        builtInTools: false,
                        sessionResumption: false,
                        requiresApiKey: false,
                        mcpSupport: false,
                    },
                    defaultModel: "mock-model",
                },
                initialize: async () => {},
                isInitialized: () => true,
                isAvailable: () => true,
                getProviderInstance: () => mockProvider,
                createModel: (modelId) => ({
                    model: mockProvider.languageModel(modelId),
                    bypassRegistry: false,
                }),
                reset: () => {},
            };

            this.providers.set("mock", mockWrapper);
        } catch (error) {
            logger.error("[ProviderRegistry] Failed to load MockProvider:", error);
            throw new Error(
                "Mock mode is enabled but MockProvider could not be loaded. " +
                "Make sure test dependencies are installed."
            );
        }
    }

    /**
     * Build the AI SDK provider registry from initialized standard providers
     */
    private buildAiSdkRegistry(): void {
        // biome-ignore lint/suspicious/noExplicitAny: AI SDK provider types vary
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const standardProviders: Record<string, any> = {};

        for (const [providerId, provider] of this.providers) {
            // Only include standard providers in the AI SDK registry
            if (provider.metadata.category === "standard") {
                const instance = provider.getProviderInstance();
                if (instance) {
                    standardProviders[providerId] = instance;
                }
            }
        }

        if (Object.keys(standardProviders).length > 0) {
            this.aiSdkRegistry = createProviderRegistry(standardProviders);
        } else {
            // Create empty registry to avoid null checks
            this.aiSdkRegistry = createProviderRegistry({});
        }
    }

    /**
     * Get a provider by ID
     */
    getProvider(providerId: string): ILLMProvider | undefined {
        return this.providers.get(providerId);
    }

    /**
     * Check if a provider is available
     */
    hasProvider(providerId: string): boolean {
        return this.providers.has(providerId) &&
               (this.providers.get(providerId)?.isAvailable() ?? false);
    }

    /**
     * Get the AI SDK provider registry
     * Used for standard providers that use createProviderRegistry
     */
    getAiSdkRegistry(): ProviderRegistryProvider {
        if (!this.aiSdkRegistry) {
            throw new Error("ProviderRegistry not initialized. Call initialize() first.");
        }
        return this.aiSdkRegistry;
    }

    /**
     * Create a model from a provider
     */
    createModel(
        providerId: string,
        modelId: string,
        context?: ProviderRuntimeContext
    ): ProviderModelResult {
        // In mock mode, always use mock provider
        const actualProviderId = process.env.USE_MOCK_LLM === "true" ? "mock" : providerId;

        const provider = this.providers.get(actualProviderId);

        if (!provider) {
            const available = Array.from(this.providers.keys());
            throw new Error(
                `Provider "${actualProviderId}" not available. ` +
                `Initialized providers: ${available.length > 0 ? available.join(", ") : "none"}`
            );
        }

        return provider.createModel(modelId, context);
    }

    /**
     * Get all available providers
     */
    getAvailableProviders(): ProviderMetadata[] {
        return Array.from(this.providers.values())
            .filter(p => p.isAvailable())
            .map(p => p.metadata);
    }

    /**
     * Get all registered providers (even if not initialized)
     */
    getRegisteredProviders(): ProviderMetadata[] {
        return Array.from(this.registrations.values()).map(r => r.metadata);
    }

    /**
     * Check if the registry is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Reset the registry
     */
    reset(): void {
        for (const provider of this.providers.values()) {
            provider.reset();
        }
        this.providers.clear();
        this.aiSdkRegistry = null;
        this.initialized = false;
    }
}

/**
 * Export singleton instance
 */
export const providerRegistry = ProviderRegistry.getInstance();
