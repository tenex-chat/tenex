import { formatAnyError } from "@/utils/error-formatter";
/**
 * OpenRouter pricing service for dynamic LLM cost calculation
 */

import { logger } from "@/utils/logger";

interface OpenRouterPricing {
    prompt: string;
    completion: string;
    request: string;
    image: string;
    web_search: string;
    internal_reasoning: string;
}

interface OpenRouterModel {
    id: string;
    name: string;
    pricing: OpenRouterPricing;
}

interface OpenRouterResponse {
    data: OpenRouterModel[];
}

interface ModelPricing {
    prompt: number;
    completion: number;
}

export class OpenRouterPricingService {
    private pricingCache: Map<string, ModelPricing> = new Map();
    private cacheExpiry = 0;
    private readonly cacheValidityMs = 60 * 60 * 1000; // 1 hour
    private readonly apiUrl = "https://openrouter.ai/api/v1/models";

    /**
     * Get pricing for a specific model
     */
    async getModelPricing(modelId: string): Promise<ModelPricing | null> {
        await this.ensureFreshCache();
        return this.pricingCache.get(modelId) || null;
    }

    /**
     * Calculate cost for token usage
     */
    async calculateCost(
        modelId: string,
        promptTokens: number,
        completionTokens: number
    ): Promise<number> {
        const pricing = await this.getModelPricing(modelId);

        if (!pricing) {
            logger.warn("Model pricing not found, using default", { modelId });
            // Return a minimal default cost
            return ((promptTokens + completionTokens) / 1_000_000) * 1.0; // $1 per 1M tokens
        }

        const promptCost = (promptTokens / 1_000_000) * pricing.prompt;
        const completionCost = (completionTokens / 1_000_000) * pricing.completion;

        return promptCost + completionCost;
    }

    /**
     * Get all available models with pricing
     */
    async getAllModelPricing(): Promise<Map<string, ModelPricing>> {
        await this.ensureFreshCache();
        return new Map(this.pricingCache);
    }

    /**
     * Force refresh the pricing cache
     */
    async refreshCache(): Promise<void> {
        try {
            const response = await fetch(this.apiUrl);

            if (!response.ok) {
                throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
            }

            const data = (await response.json()) as OpenRouterResponse;

            // Clear existing cache
            this.pricingCache.clear();

            // Populate cache with new data
            for (const model of data.data) {
                const promptPrice = Number.parseFloat(model.pricing.prompt);
                const completionPrice = Number.parseFloat(model.pricing.completion);

                // Only cache models with valid pricing
                if (!Number.isNaN(promptPrice) && !Number.isNaN(completionPrice)) {
                    this.pricingCache.set(model.id, {
                        prompt: promptPrice,
                        completion: completionPrice,
                    });
                }
            }

            this.cacheExpiry = Date.now() + this.cacheValidityMs;
        } catch (error) {
            logger.error("Failed to refresh OpenRouter pricing cache", {
                error: formatAnyError(error),
            });
            throw error;
        }
    }

    /**
     * Ensure cache is fresh, refresh if needed
     */
    private async ensureFreshCache(): Promise<void> {
        if (Date.now() > this.cacheExpiry || this.pricingCache.size === 0) {
            await this.refreshCache();
        }
    }

    /**
     * Find best matching model ID for partial model names
     * This helps with cases where the model name doesn't exactly match OpenRouter's ID
     */
    async findModelId(partialModelName: string): Promise<string | null> {
        await this.ensureFreshCache();

        const searchTerm = partialModelName.toLowerCase();

        // Exact match first
        for (const modelId of this.pricingCache.keys()) {
            if (modelId.toLowerCase() === searchTerm) {
                return modelId;
            }
        }

        // Partial match
        for (const modelId of this.pricingCache.keys()) {
            if (
                modelId.toLowerCase().includes(searchTerm) ||
                searchTerm.includes(modelId.toLowerCase())
            ) {
                return modelId;
            }
        }

        return null;
    }
}

// Export singleton instance
export const openRouterPricing = new OpenRouterPricingService();
