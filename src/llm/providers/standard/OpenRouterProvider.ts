/**
 * OpenRouter Provider
 *
 * OpenRouter provides access to multiple AI models through a single API.
 * https://openrouter.ai/
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ProviderInitConfig, ProviderMetadata } from "../types";
import { StandardProvider } from "../base/StandardProvider";

/**
 * OpenRouter provider implementation
 */
export class OpenRouterProvider extends StandardProvider {
    private static readonly _metadata: ProviderMetadata = StandardProvider.createMetadata(
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
        return OpenRouterProvider._metadata;
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
}
