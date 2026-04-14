import { describe, expect, it } from "bun:test";
import {
    didEstablishPromptCache,
    didEstablishPromptCacheFromUsage,
} from "@/agents/execution/prompt-cache";

describe("prompt-cache", () => {
    it("detects prompt cache reuse from AI SDK usage fields", () => {
        expect(didEstablishPromptCacheFromUsage({
            cachedInputTokens: 24,
        })).toBe(true);
        expect(didEstablishPromptCacheFromUsage({
            inputTokenDetails: {
                cacheReadTokens: 12,
            },
        })).toBe(true);
    });

    it("does not treat cache writes as cache reuse", () => {
        expect(didEstablishPromptCacheFromUsage({
            inputTokenDetails: {
                cacheWriteTokens: 8,
            },
        })).toBe(false);
    });

    it("detects prompt cache usage from provider metadata when usage omits cache fields", () => {
        expect(didEstablishPromptCache({
            usage: undefined,
            providerMetadata: {
                openrouter: {
                    usage: {
                        promptTokensDetails: {
                            cachedTokens: 48,
                        },
                    },
                },
            },
        })).toBe(true);
    });

    it("ignores missing or zero-valued cache signals", () => {
        expect(didEstablishPromptCacheFromUsage(undefined)).toBe(false);
        expect(didEstablishPromptCacheFromUsage({
            cachedInputTokens: 0,
            inputTokenDetails: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
            },
        })).toBe(false);
        expect(didEstablishPromptCache({
            usage: {},
            providerMetadata: {
                openrouter: {
                    usage: {
                        promptTokensDetails: {
                            cachedTokens: 0,
                        },
                    },
                },
            },
        })).toBe(false);
    });
});
