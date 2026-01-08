import { describe, it, expect, beforeEach, vi } from "vitest";
import { getContextWindow, clearCache, resolveContextWindow } from "../context-window-cache";

describe("context-window-cache", () => {
    beforeEach(() => {
        clearCache();
    });

    describe("getContextWindow", () => {
        it("returns undefined for unknown models", () => {
            expect(getContextWindow("unknown", "unknown-model")).toBeUndefined();
        });

        it("returns hardcoded value for known Anthropic models", () => {
            expect(getContextWindow("anthropic", "claude-sonnet-4-20250514")).toBe(200_000);
        });

        it("returns hardcoded value for known OpenAI models", () => {
            expect(getContextWindow("openai", "gpt-4o")).toBe(128_000);
        });
    });

    describe("resolveContextWindow", () => {
        beforeEach(() => {
            clearCache();
            vi.restoreAllMocks();
        });

        it("fetches and caches OpenRouter model context window", async () => {
            global.fetch = vi.fn().mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    data: [
                        { id: "openai/gpt-4o", context_length: 128000 },
                        { id: "anthropic/claude-3-opus", context_length: 200000 },
                    ]
                })
            });

            await resolveContextWindow("openrouter", "openai/gpt-4o");

            expect(getContextWindow("openrouter", "openai/gpt-4o")).toBe(128000);
            // Should cache all models from response
            expect(getContextWindow("openrouter", "anthropic/claude-3-opus")).toBe(200000);
        });

        it("does not fetch if already cached", async () => {
            global.fetch = vi.fn().mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ data: [{ id: "test/model", context_length: 50000 }] })
            });

            await resolveContextWindow("openrouter", "test/model");
            await resolveContextWindow("openrouter", "test/model");

            expect(fetch).toHaveBeenCalledTimes(1);
        });
    });
});
