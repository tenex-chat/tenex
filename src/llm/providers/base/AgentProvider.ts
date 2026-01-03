/**
 * Agent Provider - Base class for agent-based LLM providers
 *
 * Agent providers (like claude-code and codex-cli) have their own
 * execution model with built-in tools and session management.
 */

import type { LanguageModel } from "ai";
import type {
    ProviderInitConfig,
    ProviderRuntimeContext,
    ProviderModelResult,
} from "../types";
import { BaseProvider } from "./BaseProvider";

/**
 * Configuration type for agent provider functions
 */
export type AgentProviderFunction<TSettings = unknown> = (
    model: string,
    options?: TSettings
) => LanguageModel;

/**
 * Base class for agent-based providers
 *
 * Agent providers:
 * - Have their own built-in tools
 * - Support session resumption
 * - Bypass the standard AI SDK registry
 * - Create provider functions instead of provider instances
 */
export abstract class AgentProvider extends BaseProvider {
    protected providerFunction: AgentProviderFunction | null = null;

    /**
     * Agent providers don't use the standard provider instance
     */
    getProviderInstance(): null {
        return null;
    }

    /**
     * Get the provider function for creating models
     */
    getProviderFunction(): AgentProviderFunction | null {
        return this.providerFunction;
    }

    /**
     * Create the agent settings for the provider
     * Must be implemented by subclasses
     */
    protected abstract createAgentSettings(
        context: ProviderRuntimeContext,
        modelId: string
    ): unknown;

    /**
     * Create the provider function
     * Must be implemented by subclasses
     */
    protected abstract createProviderFunction(config: ProviderInitConfig): AgentProviderFunction;

    /**
     * Initialize the agent provider
     */
    async initialize(config: ProviderInitConfig): Promise<void> {
        this.config = config;
        this.providerFunction = this.createProviderFunction(config);
        this._initialized = true;
    }

    /**
     * Agent providers don't create a standard provider instance
     */
    protected createProviderInstance(_config: ProviderInitConfig): null {
        return null;
    }

    /**
     * Create a language model using the provider function
     */
    createModel(modelId: string, context?: ProviderRuntimeContext): ProviderModelResult {
        if (!this.providerFunction) {
            throw new Error(`Provider ${this.metadata.id} not initialized`);
        }

        const settings = this.createAgentSettings(context || {}, modelId);
        const model = this.providerFunction(modelId, settings);

        return {
            model,
            providerFunction: this.providerFunction,
            bypassRegistry: true,
        };
    }

    /**
     * Reset the provider state
     */
    reset(): void {
        super.reset();
        this.providerFunction = null;
    }
}
