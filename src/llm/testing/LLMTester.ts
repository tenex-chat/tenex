import type { LLMConfig, LLMProvider } from "@/llm/types";
import { logger } from "@/utils/logger";
import { igniteEngine, Message } from "multi-llm-ts";
import { getModelsForProvider } from "../models";

/**
 * LLM Configuration Testing Utility
 */
export class LLMTester {
    /**
     * Test an LLM configuration by sending a test message
     */
    async testLLMConfig(config: LLMConfig): Promise<boolean> {
        try {
            const llmConfig = {
                apiKey: config.apiKey,
                baseURL: config.baseUrl,
            };

            const llm = igniteEngine(config.provider, llmConfig);
            const models = await getModelsForProvider(
                config.provider as LLMProvider,
                config.apiKey
            );

            if (!models || !models.chat || models.chat.length === 0) {
                throw new Error(`No models available for provider ${config.provider}`);
            }

            // Find the specific model - handle both string and ChatModel types
            const model =
                models.chat.find((m) => {
                    const modelId = typeof m === "string" ? m : m.id;
                    return modelId === config.model;
                }) || models.chat[0];
            if (!model) {
                throw new Error(`Model ${config.model} not found for provider ${config.provider}`);
            }

            const testMessage = new Message(
                "user",
                "Say 'Configuration test successful!' and nothing else."
            );
            const response = await llm.complete(model, [testMessage]);

            return (response.content || "").toLowerCase().includes("configuration test successful");
        } catch (error) {
            logger.error("LLM test failed:", error);
            return false;
        }
    }

    /**
     * Test an existing configuration by name
     */
    async testExistingConfiguration(
        configName: string,
        configurations: Record<string, any>,
        credentials: Record<string, any>
    ): Promise<boolean> {
        const config = configurations[configName];
        if (!config) {
            throw new Error(`Configuration ${configName} not found`);
        }

        // Build the full config with credentials
        const fullConfig: LLMConfig = {
            provider: config.provider,
            model: config.model,
            enableCaching: config.enableCaching,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
        };

        // Add credentials if available
        const providerCredentials = credentials[config.provider];
        if (providerCredentials) {
            fullConfig.apiKey = providerCredentials.apiKey;
            fullConfig.baseUrl = providerCredentials.baseUrl;
        }

        return this.testLLMConfig(fullConfig);
    }

    /**
     * Validate configuration before testing
     */
    validateConfigForTesting(config: LLMConfig): { valid: boolean; error?: string } {
        if (!config.provider) {
            return { valid: false, error: "Provider is required" };
        }

        if (!config.model) {
            return { valid: false, error: "Model is required" };
        }

        if (config.provider !== "ollama" && !config.apiKey) {
            return { valid: false, error: `API key is required for ${config.provider}` };
        }

        return { valid: true };
    }

    /**
     * Get test message for specific provider (could be customized per provider)
     */
    getTestMessage(provider: LLMProvider): Message {
        // For now, use the same test message for all providers
        // This could be customized per provider in the future
        return new Message(
            "user",
            "Say 'Configuration test successful!' and nothing else."
        );
    }

    /**
     * Validate test response
     */
    isTestSuccessful(response: string): boolean {
        return response.toLowerCase().includes("configuration test successful");
    }
}
