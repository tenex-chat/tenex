/**
 * Base Provider - Abstract base class for all LLM providers
 *
 * Provides common functionality for provider implementations.
 */

import type {
    ILLMProvider,
    ProviderInitConfig,
    ProviderMetadata,
    ProviderRuntimeContext,
    ProviderModelResult,
    ProviderCapabilities,
    ProviderCategory,
} from "../types";

/**
 * Abstract base class for LLM providers
 */
export abstract class BaseProvider implements ILLMProvider {
    protected config: ProviderInitConfig | null = null;
    protected _initialized = false;

    /**
     * Get provider metadata - must be implemented by subclasses
     */
    abstract get metadata(): ProviderMetadata;

    /**
     * Create the underlying provider instance
     * Called during initialization for standard providers
     */
    protected abstract createProviderInstance(config: ProviderInitConfig): unknown | null;

    /**
     * Provider instance storage
     */
    protected providerInstance: unknown | null = null;

    /**
     * Initialize the provider with configuration
     */
    async initialize(config: ProviderInitConfig): Promise<void> {
        this.config = config;
        this.providerInstance = this.createProviderInstance(config);
        this._initialized = true;
    }

    /**
     * Check if the provider is initialized
     */
    isInitialized(): boolean {
        return this._initialized;
    }

    /**
     * Check if the provider is available
     */
    isAvailable(): boolean {
        return this._initialized;
    }

    /**
     * Get the AI SDK provider instance
     */
    getProviderInstance(): unknown | null {
        return this.providerInstance;
    }

    /**
     * Create a language model - must be implemented by subclasses
     */
    abstract createModel(modelId: string, context?: ProviderRuntimeContext): ProviderModelResult;

    /**
     * Reset the provider state
     */
    reset(): void {
        this.config = null;
        this.providerInstance = null;
        this._initialized = false;
    }

    /**
     * Helper to create metadata
     */
    protected static createMetadata(
        id: string,
        displayName: string,
        description: string,
        category: ProviderCategory,
        defaultModel: string,
        capabilities?: Partial<ProviderCapabilities>,
        documentationUrl?: string
    ): ProviderMetadata {
        return {
            id,
            displayName,
            description,
            category,
            defaultModel,
            documentationUrl,
            capabilities: {
                streaming: true,
                toolCalling: true,
                builtInTools: false,
                sessionResumption: false,
                requiresApiKey: true,
                mcpSupport: false,
                ...capabilities,
            },
        };
    }
}
