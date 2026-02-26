/**
 * LLM Service Factory
 *
 * Factory for creating LLM services with proper provider initialization.
 * This module provides a simplified interface that delegates to the
 * modular ProviderRegistry for actual provider management.
 *
 * @see src/llm/providers for individual provider implementations
 */

import type { LLMConfiguration } from "@/services/config/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import type { LanguageModel, ProviderRegistryProvider } from "ai";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";

import { LLMService } from "./service";
import {
    providerRegistry,
    type MCPConfig,
    type ProviderPoolConfig,
    type ProviderRuntimeContext,
} from "./providers";
import { PROVIDER_IDS } from "./providers/provider-ids";
import type { OnStreamStartCallback } from "./types";

/**
 * Factory for creating LLM services with proper provider initialization
 *
 * This factory provides a high-level interface for:
 * - Initializing providers from configuration
 * - Creating LLMService instances
 * - Checking provider availability
 *
 * The actual provider management is delegated to the ProviderRegistry.
 */
export class LLMServiceFactory {
    private initialized = false;

    /**
     * Initialize providers from configuration
     *
     * @param providerConfigs Map of provider names to their configurations
     * @param options Additional options for initialization
     */
    async initializeProviders(
        providerConfigs: Record<string, { apiKey: string | string[] }>
    ): Promise<void> {
        // Convert to ProviderPoolConfig format
        // apiKey can be a single string or an array — KeyManager handles the rest
        const configs: Record<string, ProviderPoolConfig> = {};
        for (const [name, config] of Object.entries(providerConfigs)) {
            const hasKey = Array.isArray(config?.apiKey)
                ? config.apiKey.length > 0
                : !!config?.apiKey;

            if (hasKey) {
                configs[name] = {
                    apiKey: config.apiKey,
                };
            }
        }

        // Also ensure agent providers are initialized (they don't need API keys).
        // Add them with empty configs if not already present.
        const agentProviders = [PROVIDER_IDS.CLAUDE_CODE, PROVIDER_IDS.CODEX_APP_SERVER];
        for (const providerId of agentProviders) {
            if (!configs[providerId]) {
                configs[providerId] = {};
            }
        }

        // Initialize through the registry (which has its own tracing span)
        const results = await providerRegistry.initialize(configs);

        // Log initialization failures
        const failed = results.filter(r => !r.success);
        if (failed.length > 0) {
            for (const f of failed) {
                logger.error(`[LLMServiceFactory] Failed to initialize provider ${f.providerId}`, {
                    error: f.error,
                });
            }
        }

        this.initialized = true;
    }

    /**
     * Create an LLM service from a resolved configuration
     *
     * @param config LLM configuration
     * @param context Optional runtime context for agents
     */
    createService(
        config: LLMConfiguration,
        context?: {
            tools?: Record<string, AISdkTool>;
            agentName?: string;
            sessionId?: string;
            /** Working directory path for agent execution */
            workingDirectory?: string;
            /** MCP configuration - passed from services layer to providers */
            mcpConfig?: MCPConfig;
            /** Conversation ID for OpenRouter correlation */
            conversationId?: string;
            /** Callback invoked when Claude Code stream starts, providing the message injector */
            onStreamStart?: OnStreamStartCallback;
        }
    ): LLMService {
        if (!this.initialized) {
            throw new Error("LLMServiceFactory not initialized. Call initializeProviders first.");
        }

        // Convert agent name to slug format for telemetry
        const agentSlug = context?.agentName
            ? context.agentName.toLowerCase().replace(/\s+/g, "-")
            : undefined;

        // Determine the actual provider (mock mode handling)
        const actualProvider = process.env.USE_MOCK_LLM === "true" ? "mock" : config.provider;

        // Build the runtime context for the provider
        const runtimeContext: ProviderRuntimeContext = {
            tools: context?.tools,
            agentName: context?.agentName,
            sessionId: context?.sessionId,
            workingDirectory: context?.workingDirectory,
            mcpConfig: context?.mcpConfig,
            reasoningEffort: (config as { reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" }).reasoningEffort,
            onStreamStart: context?.onStreamStart,
        };

        // Get the provider from the registry
        const provider = providerRegistry.getProvider(actualProvider);

        if (!provider) {
            const available = providerRegistry.getAvailableProviders().map(p => p.id);
            throw new Error(
                `Provider "${actualProvider}" not available. ` +
                `Initialized providers: ${available.length > 0 ? available.join(", ") : "none"}`
            );
        }

        // Create the model from the provider
        const modelResult = provider.createModel(config.model, runtimeContext);

        // Get capabilities from provider metadata
        const capabilities = provider.metadata.capabilities;

        // For agent providers (claude-code, codex-app-server), use their provider function
        if (modelResult.bypassRegistry && modelResult.providerFunction) {
            return new LLMService(
                null,
                actualProvider,
                config.model,
                capabilities,
                config.temperature,
                config.maxTokens,
                modelResult.providerFunction as (model: string, options?: ClaudeCodeSettings) => LanguageModel,
                modelResult.agentSettings as ClaudeCodeSettings,
                context?.sessionId,
                agentSlug,
                context?.conversationId
            );
        }

        // For standard providers, use the AI SDK registry
        const registry = providerRegistry.getAiSdkRegistry();

        return new LLMService(
            registry,
            actualProvider,
            config.model,
            capabilities,
            config.temperature,
            config.maxTokens,
            undefined,
            undefined,
            context?.sessionId,
            agentSlug,
            context?.conversationId
        );
    }

    /**
     * Check if a provider is available
     */
    hasProvider(providerName: string): boolean {
        return providerRegistry.hasProvider(providerName);
    }

    /**
     * Get the AI SDK provider registry
     * Useful for direct access to language models
     */
    getRegistry(): ProviderRegistryProvider {
        if (!this.initialized) {
            throw new Error("LLMServiceFactory not initialized. Call initializeProviders first.");
        }
        return providerRegistry.getAiSdkRegistry();
    }

    /**
     * Get list of available providers
     */
    getAvailableProviders(): string[] {
        return providerRegistry.getAvailableProviders().map(p => p.id);
    }

    /**
     * Get list of all registered providers (even if not initialized)
     */
    getRegisteredProviders(): string[] {
        return providerRegistry.getRegisteredProviders().map(p => p.id);
    }

    /**
     * Reset the factory (mainly for testing)
     */
    reset(): void {
        providerRegistry.reset();
        this.initialized = false;
    }
}

/**
 * Export singleton instance
 */
export const llmServiceFactory = new LLMServiceFactory();
