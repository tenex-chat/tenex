import type { LLMProvider } from "@/llm/types";
import search from "@inquirer/search";
// Removed ModelsList import - using simple string arrays now
import { getModelsForProvider } from "../models";

export interface ModelSelectionResult {
    model: string;
    supportsCaching: boolean;
}

/**
 * Model selection utilities for different LLM providers
 */
export class ModelSelector {
    async selectModelWithSearch(provider: string, models: string[]): Promise<string> {
        const formattedModels = models.map((model) => ({
            name: model,
            value: model,
        }));

        return search({
            message: `Select ${provider} model:`,
            source: async (input) => {
                if (!input) {
                    return formattedModels;
                }
                const filtered = formattedModels.filter((model) =>
                    model.name.toLowerCase().includes(input.toLowerCase())
                );
                return filtered.length > 0 ? filtered : formattedModels;
            },
        });
    }

    async selectOpenRouterModelWithPricing(models: string[]): Promise<ModelSelectionResult> {
        const formattedModels = models.map((model) => ({
            name: model,
            value: model,
            short: model,
        }));

        const model = await search({
            message: "Select OpenRouter model (📦 = supports caching):",
            source: async (input) => {
                if (!input) {
                    return formattedModels;
                }
                const filtered = formattedModels.filter((model) =>
                    model.value.toLowerCase().includes(input.toLowerCase())
                );
                return filtered.length > 0 ? filtered : formattedModels;
            },
        });

        return {
            model,
            supportsCaching: false, // We don't have this info available
        };
    }

    async fetchAndSelectModel(
        provider: LLMProvider,
        existingApiKey?: string,
        ollamaUrl?: string
    ): Promise<ModelSelectionResult | null> {
        try {
            const models = await getModelsForProvider(provider);
            if (!models || models.length === 0) {
                return null;
            }

            const availableModels = models;

            if (provider === "openrouter") {
                return await this.selectOpenRouterModelWithPricing(availableModels);
            }
            const model = await this.selectModelWithSearch(provider, availableModels);
            return { model, supportsCaching: false };
        } catch (error) {
            throw new Error(`Failed to fetch ${provider} models: ${error}`);
        }
    }

    getAvailableModelCount(models: string[] | null): number {
        if (!models) return 0;
        return models.length;
    }

    shouldSupportCaching(provider: LLMProvider, model: string, supportsCaching: boolean): boolean {
        return (
            (provider === "anthropic" && model.includes("claude")) ||
            (provider === "openrouter" && supportsCaching)
        );
    }

    generateDefaultConfigName(provider: string, model: string): string {
        return `${provider}-${model}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
}
