import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
import { PROVIDER_IDS } from "./providers/provider-ids";

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Anthropic automatic prompt caching is enabled via request-level provider options.
 * Callers can still override this default with explicit anthropic provider options.
 */
export function getDefaultProviderOptions(provider: string): ProviderOptions | undefined {
    if (provider !== PROVIDER_IDS.ANTHROPIC) {
        return undefined;
    }

    return {
        anthropic: {
            cacheControl: { type: "ephemeral" },
        },
    };
}

export function mergeProviderOptions(
    base: ProviderOptions | undefined,
    extra: ProviderOptions | undefined
): ProviderOptions | undefined {
    if (!base) {
        return extra;
    }

    if (!extra) {
        return base;
    }

    const merged: ProviderOptions = { ...base };

    for (const [provider, value] of Object.entries(extra)) {
        const existing = merged[provider];
        if (isObject(existing) && isObject(value)) {
            merged[provider] = {
                ...existing,
                ...value,
            };
            continue;
        }

        merged[provider] = value;
    }

    return merged;
}
