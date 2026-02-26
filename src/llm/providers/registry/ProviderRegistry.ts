/**
 * Provider Registry - Central registry for all LLM providers
 *
 * This module provides a unified registry for managing LLM providers,
 * supporting both standard AI SDK providers and custom agent providers.
 * Integrates with KeyManager for multi-key rotation and fallback.
 */

import { createProviderRegistry } from "ai";
import type { ProviderRegistryProvider } from "ai";
import type { ProviderV3 } from "@ai-sdk/provider";
import { logger } from "@/utils/logger";
import { keyManager } from "../key-manager";
import type {
    ILLMProvider,
    ProviderInitConfig,
    ProviderPoolConfig,
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
 * 4. Key Rotation - Providers can be re-initialized with a different key on failure
 */
export class ProviderRegistry {
    private static instance: ProviderRegistry | null = null;

    private providers: Map<string, ILLMProvider> = new Map();
    private registrations: Map<string, ProviderRegistration> = new Map();
    private providerConfigs: Map<string, ProviderPoolConfig> = new Map();
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
     * Initialize all registered providers with their configurations.
     * Supports multi-key configs — keys are registered with KeyManager
     * and a single key is selected for each provider's initial setup.
     */
    async initialize(
        configs: Record<string, ProviderPoolConfig>,
        _options?: { enableTenexTools?: boolean }
    ): Promise<InitializationResult[]> {
        const results: InitializationResult[] = [];
        this.providers.clear();
        this.providerConfigs.clear();

        // Check if mock mode is enabled
        if (process.env.USE_MOCK_LLM === "true") {
            await this.initializeMockProvider();
        }

        // Register all key pools with KeyManager and initialize providers
        for (const [providerId, registration] of this.registrations) {
            const config = configs[providerId];
            const apiKey = config?.apiKey;

            // Register keys with KeyManager (handles string | string[])
            if (apiKey) {
                keyManager.registerKeys(providerId, apiKey);
            }

            // Skip providers without config (unless they don't require API key)
            if (!apiKey && registration.metadata.capabilities.requiresApiKey) {
                continue;
            }

            // Store the full config for potential re-initialization
            if (config) {
                this.providerConfigs.set(providerId, config);
            }

            // Select a single key for this initialization
            const selectedKey = apiKey ? keyManager.selectKey(providerId) : undefined;

            try {
                const provider = new registration.Provider();
                const initConfig: ProviderInitConfig = {
                    apiKey: selectedKey,
                    baseUrl: config?.baseUrl,
                    options: config?.options,
                };
                await provider.initialize(initConfig);
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
     * Re-initialize a provider with a different API key.
     * Called when a key fails at runtime to attempt fallback.
     *
     * @param providerId The provider to re-initialize
     * @param failedKey The key that failed (will be reported to KeyManager)
     * @returns true if re-initialization succeeded with a new key
     */
    async reinitializeProvider(providerId: string, failedKey: string): Promise<boolean> {
        if (!keyManager.hasMultipleKeys(providerId)) {
            return false;
        }

        // Report the failure to track key health
        keyManager.reportFailure(providerId, failedKey);

        // Select a new key (KeyManager will avoid disabled keys)
        const newKey = keyManager.selectKey(providerId);
        if (!newKey || newKey === failedKey) {
            logger.warn(`[ProviderRegistry] No alternative key available for "${providerId}"`);
            return false;
        }

        const registration = this.registrations.get(providerId);
        const originalConfig = this.providerConfigs.get(providerId);
        if (!registration || !originalConfig) {
            return false;
        }

        try {
            // Reset the old provider
            const oldProvider = this.providers.get(providerId);
            if (oldProvider) {
                oldProvider.reset();
            }

            // Create and initialize a new provider instance with the new key
            const provider = new registration.Provider();
            const initConfig: ProviderInitConfig = {
                apiKey: newKey,
                baseUrl: originalConfig.baseUrl,
                options: originalConfig.options,
            };
            await provider.initialize(initConfig);
            this.providers.set(providerId, provider);

            // Rebuild the AI SDK registry to reflect the new provider instance
            this.buildAiSdkRegistry();

            const keyPreview = newKey.slice(0, 8) + "...";
            logger.info(`[ProviderRegistry] Re-initialized "${providerId}" with key ${keyPreview}`);
            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`[ProviderRegistry] Failed to re-initialize "${providerId}"`, {
                error: errorMessage,
            });
            return false;
        }
    }

    /**
     * Get the currently active API key for a provider.
     * Used by callers that need to report which key failed.
     */
    getActiveApiKey(providerId: string): string | undefined {
        const provider = this.providers.get(providerId);
        if (!provider) return undefined;

        // Access the stored config on the base provider
        const config = (provider as unknown as { config?: ProviderInitConfig }).config;
        if (!config?.apiKey) return undefined;

        // At this point, the provider was initialized with a single key
        return typeof config.apiKey === "string" ? config.apiKey : undefined;
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
                "Make sure test dependencies are installed.",
                { cause: error }
            );
        }
    }

    /**
     * Build the AI SDK provider registry from initialized standard providers
     */
    private buildAiSdkRegistry(): void {
        const standardProviders: Record<string, ProviderV3> = {};

        for (const [providerId, provider] of this.providers) {
            // Only include standard providers in the AI SDK registry
            if (provider.metadata.category === "standard") {
                const instance = provider.getProviderInstance();
                if (instance) {
                    standardProviders[providerId] = instance as ProviderV3;
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
        this.providerConfigs.clear();
        this.aiSdkRegistry = null;
        this.initialized = false;
        keyManager.reset();
    }
}

/**
 * Export singleton instance
 */
export const providerRegistry = ProviderRegistry.getInstance();
