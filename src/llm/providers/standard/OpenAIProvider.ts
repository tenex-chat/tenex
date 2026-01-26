/**
 * OpenAI Provider
 *
 * Direct access to OpenAI's GPT models.
 * https://openai.com/
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderInitConfig, ProviderMetadata } from "../types";
import { StandardProvider } from "../base/StandardProvider";
import { PROVIDER_IDS } from "../provider-ids";

/**
 * OpenAI provider implementation
 */
export class OpenAIProvider extends StandardProvider {
    static readonly METADATA: ProviderMetadata = StandardProvider.createMetadata(
        PROVIDER_IDS.OPENAI,
        "OpenAI",
        "Direct access to GPT models",
        "standard",
        "gpt-4",
        {
            streaming: true,
            toolCalling: true,
            requiresApiKey: true,
        },
        "https://platform.openai.com/docs/"
    );

    get metadata(): ProviderMetadata {
        return OpenAIProvider.METADATA;
    }

    protected createProviderInstance(config: ProviderInitConfig): unknown {
        if (!config.apiKey) {
            throw new Error("OpenAI requires an API key");
        }

        return createOpenAI({
            apiKey: config.apiKey,
        });
    }
}
