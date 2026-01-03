/**
 * Ollama Provider
 *
 * Run open-source LLMs locally with Ollama.
 * https://ollama.ai/
 */

import { createOllama } from "ollama-ai-provider-v2";
import type { ProviderInitConfig, ProviderMetadata } from "../types";
import { StandardProvider } from "../base/StandardProvider";

/**
 * Ollama provider implementation
 */
export class OllamaProvider extends StandardProvider {
    private static readonly _metadata: ProviderMetadata = StandardProvider.createMetadata(
        "ollama",
        "Ollama",
        "Run open-source LLMs locally",
        "standard",
        "llama3.1:8b",
        {
            streaming: true,
            toolCalling: true,
            requiresApiKey: false, // Ollama uses a base URL instead of API key
        },
        "https://ollama.ai/"
    );

    get metadata(): ProviderMetadata {
        return OllamaProvider._metadata;
    }

    protected createProviderInstance(config: ProviderInitConfig): unknown {
        // For Ollama, apiKey is actually the base URL
        // The library expects the URL to include /api path
        let baseURL: string | undefined;

        if (!config.apiKey || config.apiKey === "local") {
            // Use default (library provides http://127.0.0.1:11434/api)
            baseURL = undefined;
        } else {
            // Custom URL - ensure it ends with /api
            baseURL = config.apiKey.endsWith("/api")
                ? config.apiKey
                : `${config.apiKey.replace(/\/$/, "")}/api`;
        }

        return createOllama(baseURL ? { baseURL } : undefined);
    }

    /**
     * Ollama is available if initialized (no API key required)
     */
    isAvailable(): boolean {
        return this._initialized;
    }
}
