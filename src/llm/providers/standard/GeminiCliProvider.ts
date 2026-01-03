/**
 * Gemini CLI Provider
 *
 * Access Google's Gemini models through the Gemini CLI.
 * Uses OAuth personal authentication.
 */

import { createGeminiProvider } from "ai-sdk-provider-gemini-cli";
import type { ProviderInitConfig, ProviderMetadata } from "../types";
import { StandardProvider } from "../base/StandardProvider";

/**
 * Gemini CLI provider implementation
 */
export class GeminiCliProvider extends StandardProvider {
    static readonly METADATA: ProviderMetadata = StandardProvider.createMetadata(
        "gemini-cli",
        "Gemini CLI",
        "Access Gemini models via CLI with OAuth",
        "standard",
        "gemini-2.0-flash-exp",
        {
            streaming: true,
            toolCalling: true,
            requiresApiKey: false, // Uses OAuth instead
        },
        "https://ai.google.dev/"
    );

    get metadata(): ProviderMetadata {
        return GeminiCliProvider.METADATA;
    }

    protected createProviderInstance(_config: ProviderInitConfig): unknown {
        return createGeminiProvider({ authType: "oauth-personal" });
    }

    /**
     * Gemini CLI is always available (uses OAuth)
     */
    isAvailable(): boolean {
        return this._initialized;
    }
}
