/**
 * Standard Provider - Base class for standard AI SDK providers
 *
 * Standard providers use AI SDK's createProviderRegistry and follow
 * the standard language model pattern.
 */

import type { ProviderRuntimeContext, ProviderModelResult } from "../types";
import { BaseProvider } from "./BaseProvider";

/**
 * Base class for standard AI SDK providers
 *
 * Standard providers:
 * - Use AI SDK's provider packages (@ai-sdk/openai, @ai-sdk/anthropic, etc.)
 * - Are registered in createProviderRegistry
 * - Use the registry.languageModel() pattern
 */
export abstract class StandardProvider extends BaseProvider {
    /**
     * Create a language model using the standard registry pattern
     */
    createModel(modelId: string, _context?: ProviderRuntimeContext): ProviderModelResult {
        if (!this.providerInstance) {
            throw new Error(`Provider ${this.metadata.id} not initialized`);
        }

        // Standard providers get their model from the AI SDK registry
        // The actual model creation is done by the registry in LLMService
        const provider = this.providerInstance as { languageModel: (id: string) => unknown };
        const model = provider.languageModel(modelId);

        return {
            model: model as import("ai").LanguageModel,
            bypassRegistry: false,
        };
    }
}
