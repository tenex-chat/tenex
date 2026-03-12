/**
 * OpenAI-Compatible Provider
 *
 * Any server that implements the OpenAI API (vLLM, LM Studio, llama.cpp, etc.)
 * pointed at a custom base URL.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderInitConfig, ProviderMetadata } from "../types";
import { StandardProvider } from "../base/StandardProvider";
import { PROVIDER_IDS } from "../provider-ids";

export class OpenAICompatibleProvider extends StandardProvider {
    static readonly METADATA: ProviderMetadata = StandardProvider.createMetadata(
        PROVIDER_IDS.OPENAI_COMPATIBLE,
        "OpenAI-Compatible",
        "Any OpenAI-compatible API endpoint (vLLM, LM Studio, llama.cpp, etc.)",
        "standard",
        "default",
        {
            streaming: true,
            toolCalling: true,
            requiresApiKey: false,
        },
        "https://platform.openai.com/docs/api-reference"
    );

    get metadata(): ProviderMetadata {
        return OpenAICompatibleProvider.METADATA;
    }

    protected createProviderInstance(config: ProviderInitConfig): unknown {
        if (!config.baseUrl) {
            throw new Error("OpenAI-compatible provider requires a baseUrl");
        }

        return createOpenAI({
            baseURL: config.baseUrl,
            apiKey: config.apiKey ?? "not-required",
        });
    }
}
