/**
 * OpenRouter Provider
 *
 * OpenRouter provides access to multiple AI models through a single API.
 * https://openrouter.ai/
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModelUsage } from "ai";
import type { LanguageModelUsageWithCostUsd } from "../../types";
import type { ProviderInitConfig, ProviderMetadata } from "../types";
import { StandardProvider } from "../base/StandardProvider";

/**
 * OpenRouter-specific metadata structure
 */
interface OpenRouterProviderMetadata {
    id?: string;
    usage?: {
        cost?: number;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        promptTokensDetails?: { cachedTokens?: number };
        completionTokensDetails?: { reasoningTokens?: number };
    };
}

/**
 * OpenRouter provider implementation
 */
export class OpenRouterProvider extends StandardProvider {
    static readonly METADATA: ProviderMetadata = StandardProvider.createMetadata(
        "openrouter",
        "OpenRouter",
        "Access multiple AI models through a single API",
        "standard",
        "openai/gpt-4",
        {
            streaming: true,
            toolCalling: true,
            requiresApiKey: true,
        },
        "https://openrouter.ai/docs"
    );

    get metadata(): ProviderMetadata {
        return OpenRouterProvider.METADATA;
    }

    protected createProviderInstance(config: ProviderInitConfig): unknown {
        if (!config.apiKey) {
            throw new Error("OpenRouter requires an API key");
        }

        return createOpenRouter({
            apiKey: config.apiKey,
            headers: {
                "X-Title": "TENEX",
                "HTTP-Referer": "https://tenex.chat/",
            },
        });
    }

    /**
     * Extract usage metadata from OpenRouter provider response
     */
    static extractUsageMetadata(
        model: string,
        totalUsage: LanguageModelUsage | undefined,
        providerMetadata: Record<string, unknown> | undefined
    ): LanguageModelUsageWithCostUsd {
        const metadata = providerMetadata?.openrouter as OpenRouterProviderMetadata | undefined;
        const usage = metadata?.usage;

        const inputTokens = usage?.promptTokens ?? totalUsage?.inputTokens;
        const outputTokens = usage?.completionTokens ?? totalUsage?.outputTokens;
        const totalTokens = usage?.totalTokens ??
            (inputTokens !== undefined && outputTokens !== undefined
                ? inputTokens + outputTokens
                : undefined);

        return {
            model,
            inputTokens,
            outputTokens,
            totalTokens,
            costUsd: usage?.cost,
            cachedInputTokens: usage?.promptTokensDetails?.cachedTokens,
            reasoningTokens: usage?.completionTokensDetails?.reasoningTokens,
        } as LanguageModelUsageWithCostUsd;
    }

    /**
     * Extract OpenRouter generation ID for trace correlation
     */
    static extractGenerationId(
        providerMetadata: Record<string, unknown> | undefined
    ): string | undefined {
        return (providerMetadata?.openrouter as OpenRouterProviderMetadata | undefined)?.id;
    }
}
