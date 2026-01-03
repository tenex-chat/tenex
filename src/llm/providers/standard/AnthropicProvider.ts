/**
 * Anthropic Provider
 *
 * Direct access to Anthropic's Claude models.
 * https://www.anthropic.com/
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderInitConfig, ProviderMetadata } from "../types";
import { StandardProvider } from "../base/StandardProvider";

/**
 * Anthropic provider implementation
 */
export class AnthropicProvider extends StandardProvider {
    private static readonly _metadata: ProviderMetadata = StandardProvider.createMetadata(
        "anthropic",
        "Anthropic",
        "Direct access to Claude models",
        "standard",
        "claude-sonnet-4-20250514",
        {
            streaming: true,
            toolCalling: true,
            requiresApiKey: true,
        },
        "https://docs.anthropic.com/"
    );

    get metadata(): ProviderMetadata {
        return AnthropicProvider._metadata;
    }

    protected createProviderInstance(config: ProviderInitConfig): unknown {
        if (!config.apiKey) {
            throw new Error("Anthropic requires an API key");
        }

        return createAnthropic({
            apiKey: config.apiKey,
        });
    }
}
