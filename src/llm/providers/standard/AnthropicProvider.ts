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
import type { ProviderInitConfig, ProviderMetadata } from "../types";
import { StandardProvider } from "../base/StandardProvider";
import { PROVIDER_IDS } from "../provider-ids";

/**
 * Beta headers required when using OAuth setup-tokens.
 *
 * oauth-2025-04-20 + claude-code-20250219: enable Bearer auth as Claude Code identity.
 * fine-grained-tool-streaming-2025-05-14: required for sonnet-4+ models to accept OAuth auth.
 */
const OAUTH_BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "fine-grained-tool-streaming-2025-05-14",
];

/**
 * Anthropic requires OAuth requests to identify as Claude Code.
 * Without this system prompt prefix, sonnet-4+ models reject the request with a
 * cryptic 400 "invalid_request_error: Error".
 */
const OAUTH_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Wraps fetch for OAuth token requests to inject the mandatory Claude Code system prompt.
 * The Anthropic API enforces this identity check for setup-token (sk-ant-oat*) auth.
 */
const oauthFetch: typeof globalThis.fetch = Object.assign(
    async (...[url, init]: Parameters<typeof globalThis.fetch>): Promise<Response> => {
        if (init?.body && typeof init.body === "string") {
            try {
                const body = JSON.parse(init.body) as Record<string, unknown>;
                const existing = body.system;
                if (typeof existing === "string" && existing.length > 0) {
                    body.system = [
                        { type: "text", text: OAUTH_SYSTEM_PROMPT },
                        { type: "text", text: existing },
                    ];
                } else if (Array.isArray(existing)) {
                    body.system = [{ type: "text", text: OAUTH_SYSTEM_PROMPT }, ...existing];
                } else {
                    body.system = [{ type: "text", text: OAUTH_SYSTEM_PROMPT }];
                }
                init = { ...init, body: JSON.stringify(body) };
            } catch {
                // not JSON, leave as-is
            }
        }
        return globalThis.fetch(url, init);
    },
    { preconnect: (globalThis.fetch as { preconnect?: unknown }).preconnect },
);

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
            return createAnthropic({
                authToken: config.apiKey,
                headers: {
                    "anthropic-beta": OAUTH_BETAS.join(","),
                    "anthropic-dangerous-direct-browser-access": "true",
                    "x-app": "cli",
                },
                fetch: oauthFetch,
            });
        }

        return createAnthropic({
            apiKey: config.apiKey,
        });
    }
}
