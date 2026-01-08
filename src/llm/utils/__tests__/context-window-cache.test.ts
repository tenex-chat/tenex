import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { getContextWindow, clearCache, resolveContextWindow } from "../context-window-cache";

describe("context-window-cache", () => {
    beforeEach(() => {
        clearCache();
    });

    describe("getContextWindow", () => {
        test("returns undefined for unknown models", () => {
            expect(getContextWindow("unknown", "unknown-model")).toBeUndefined();
        });

        test("returns hardcoded value for known Anthropic models", () => {
            expect(getContextWindow("anthropic", "claude-sonnet-4-20250514")).toBe(200_000);
        });

        test("returns hardcoded value for known OpenAI models", () => {
            expect(getContextWindow("openai", "gpt-4o")).toBe(128_000);
        });
    });

    describe("resolveContextWindow", () => {
        beforeEach(() => {
            clearCache();
        });

        test("fetches and caches OpenRouter model context window", async () => {
            const mockFetch = mock(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            data: [
                                { id: "openai/gpt-4o", context_length: 128000 },
                                { id: "anthropic/claude-3-opus", context_length: 200000 },
                            ],
                        }),
                })
            );
            global.fetch = mockFetch as unknown as typeof fetch;

            await resolveContextWindow("openrouter", "openai/gpt-4o");

            expect(getContextWindow("openrouter", "openai/gpt-4o")).toBe(128000);
            // Should cache all models from response
            expect(getContextWindow("openrouter", "anthropic/claude-3-opus")).toBe(200000);
        });

        test("does not fetch if already cached", async () => {
            const mockFetch = mock(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({ data: [{ id: "test/model", context_length: 50000 }] }),
                })
            );
            global.fetch = mockFetch as unknown as typeof fetch;

            await resolveContextWindow("openrouter", "test/model");
            await resolveContextWindow("openrouter", "test/model");

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test("fetches Ollama model context window via /api/show", async () => {
            const mockFetch = mock(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            model_info: {
                                "llama.context_length": 8192,
                            },
                        }),
                })
            );
            global.fetch = mockFetch as unknown as typeof fetch;

            await resolveContextWindow("ollama", "llama3.2:3b");

            expect(getContextWindow("ollama", "llama3.2:3b")).toBe(8192);
            expect(mockFetch).toHaveBeenCalledWith(
                "http://localhost:11434/api/show",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ name: "llama3.2:3b" }),
                })
            );
        });
    });
});
