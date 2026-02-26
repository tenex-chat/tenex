/**
 * Anthropic Provider
 *
 * Direct access to Anthropic's Claude models.
 * Supports both API keys (sk-ant-api*) and OAuth setup-tokens (sk-ant-oat*)
 * from `claude setup-token` for Claude Code Max subscription auth.
 *
 * https://www.anthropic.com/
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { logger } from "@/utils/logger";
import type { ProviderInitConfig, ProviderMetadata } from "../types";
import { StandardProvider } from "../base/StandardProvider";
import { PROVIDER_IDS } from "../provider-ids";

/**
 * Beta headers required when using OAuth setup-tokens.
 * Without these, Anthropic rejects OAuth Bearer auth with 401.
 */
const OAUTH_BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
];

function isOAuthToken(key: string): boolean {
    return key.startsWith("sk-ant-oat");
}

/**
 * Anthropic provider implementation
 */
export class AnthropicProvider extends StandardProvider {
    static readonly METADATA: ProviderMetadata = StandardProvider.createMetadata(
        PROVIDER_IDS.ANTHROPIC,
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
        return AnthropicProvider.METADATA;
    }

    protected createProviderInstance(config: ProviderInitConfig): unknown {
        if (!config.apiKey) {
            throw new Error("Anthropic requires an API key or setup-token");
        }

        if (isOAuthToken(config.apiKey)) {
            logger.info("[AnthropicProvider] Using OAuth setup-token auth (Claude Code Max subscription)");
            return createAnthropic({
                authToken: config.apiKey,
                headers: {
                    "anthropic-beta": OAUTH_BETAS.join(","),
                },
            });
        }

        return createAnthropic({
            apiKey: config.apiKey,
        });
    }
}
