/**
 * Provider type definitions for the modular LLM provider registry
 *
 * This module defines the interfaces and types for creating modular,
 * pluggable LLM providers that can be easily registered and used.
 */

import type { LanguageModel } from "ai";
import type { AISdkTool } from "@/tools/types";

/**
 * Provider categories
 */
export type ProviderCategory = "standard" | "agent";

/**
 * Provider capability flags
 */
export interface ProviderCapabilities {
    /** Whether the provider supports streaming responses */
    streaming: boolean;
    /** Whether the provider supports tool/function calling */
    toolCalling: boolean;
    /** Whether the provider has built-in tools (like claude-code) */
    builtInTools: boolean;
    /** Whether the provider supports session resumption */
    sessionResumption: boolean;
    /** Whether the provider requires an API key */
    requiresApiKey: boolean;
    /** Whether the provider supports MCP servers */
    mcpSupport: boolean;
}

/**
 * Default capabilities for standard providers
 */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    builtInTools: false,
    sessionResumption: false,
    requiresApiKey: true,
    mcpSupport: false,
};

/**
 * Provider metadata for display and configuration
 */
export interface ProviderMetadata {
    /** Unique identifier for the provider */
    id: string;
    /** Human-readable display name */
    displayName: string;
    /** Short description of the provider */
    description: string;
    /** Provider category */
    category: ProviderCategory;
    /** Provider capabilities */
    capabilities: ProviderCapabilities;
    /** Default model for this provider */
    defaultModel: string;
    /** Website/documentation URL */
    documentationUrl?: string;
}

/**
 * Configuration for initializing a provider
 */
export interface ProviderInitConfig {
    /** API key or authentication token */
    apiKey?: string;
    /** Base URL for the API (for self-hosted providers) */
    baseUrl?: string;
    /** Additional provider-specific options */
    options?: Record<string, unknown>;
}

/**
 * Runtime context for creating LLM services
 */
export interface ProviderRuntimeContext {
    /** Available tools for the agent */
    tools?: Record<string, AISdkTool>;
    /** Agent name for telemetry */
    agentName?: string;
    /** Session ID for resumable sessions */
    sessionId?: string;
    /** Working directory for agent execution */
    workingDirectory?: string;
    /** MCP servers configuration */
    mcpServers?: Record<string, unknown>;
    /** Whether TENEX tools should be enabled */
    enableTenexTools?: boolean;
}

/**
 * Result of creating a language model from a provider
 */
export interface ProviderModelResult {
    /** The language model instance */
    model: LanguageModel;
    /** Provider function for special providers (claudeCode, codexCli) */
    providerFunction?: (model: string, options?: unknown) => LanguageModel;
    /** Whether this provider bypasses the standard registry */
    bypassRegistry: boolean;
}

/**
 * Interface for LLM providers
 *
 * Providers implement this interface to be registered in the provider registry.
 * There are two types:
 * - Standard providers: Use AI SDK's createProviderRegistry
 * - Agent providers: Have their own provider functions (claudeCode, codexCli)
 */
export interface ILLMProvider {
    /** Provider metadata */
    readonly metadata: ProviderMetadata;

    /**
     * Initialize the provider with configuration
     * @param config Provider configuration (API key, etc.)
     * @returns Promise that resolves when initialization is complete
     */
    initialize(config: ProviderInitConfig): Promise<void>;

    /**
     * Check if the provider is initialized
     */
    isInitialized(): boolean;

    /**
     * Check if the provider is available (initialized and ready to use)
     */
    isAvailable(): boolean;

    /**
     * Get the AI SDK provider instance for standard providers
     * Used by createProviderRegistry
     * @returns The provider instance or null for agent providers
     */
    getProviderInstance(): unknown | null;

    /**
     * Create a language model for this provider
     * @param modelId The model ID to use
     * @param context Runtime context for the model
     * @returns The model result with language model and metadata
     */
    createModel(modelId: string, context?: ProviderRuntimeContext): ProviderModelResult;

    /**
     * Reset the provider state
     */
    reset(): void;
}

/**
 * Provider constructor type
 */
export type ProviderConstructor = new () => ILLMProvider;

/**
 * Provider registration entry
 */
export interface ProviderRegistration {
    /** The provider class constructor */
    Provider: ProviderConstructor;
    /** Provider metadata (cached for quick access) */
    metadata: ProviderMetadata;
}
