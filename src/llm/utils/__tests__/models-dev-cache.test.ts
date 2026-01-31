import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
    getModelLimits,
    getContextWindowFromModelsdev,
    clearModelsDevCache,
    ensureCacheLoaded,
} from "../models-dev-cache";
import * as fs from "@/lib/fs";
import * as configService from "@/services/ConfigService";

describe("models-dev-cache", () => {
    let fetchSpy: ReturnType<typeof spyOn>;
    let fileExistsSpy: ReturnType<typeof spyOn>;
    let readJsonFileSpy: ReturnType<typeof spyOn>;
    let writeJsonFileSpy: ReturnType<typeof spyOn>;
    let ensureDirectorySpy: ReturnType<typeof spyOn>;
    let getFileStatsSpy: ReturnType<typeof spyOn>;
    let getConfigPathSpy: ReturnType<typeof spyOn>;

    const mockModelsDevResponse = {
        anthropic: {
            models: {
                "claude-opus-4-5-20251101": {
                    limit: { context: 200000, output: 64000 },
                },
                "claude-sonnet-4-20250514": {
                    limit: { context: 200000, output: 32000 },
                },
            },
        },
        openai: {
            models: {
                "gpt-4o": {
                    limit: { context: 128000, output: 16384 },
                },
                "gpt-4o-mini": {
                    limit: { context: 128000, output: 16384 },
                },
            },
        },
        openrouter: {
            models: {
                "anthropic/claude-3-opus": {
                    limit: { context: 200000, output: 4096 },
                },
            },
        },
    };

    beforeEach(() => {
        clearModelsDevCache();

        // Mock config path
        getConfigPathSpy = spyOn(configService.config, "getConfigPath").mockReturnValue(
            "/tmp/tenex-test"
        );

        // Mock file system
        fileExistsSpy = spyOn(fs, "fileExists").mockResolvedValue(false);
        readJsonFileSpy = spyOn(fs, "readJsonFile").mockResolvedValue(null);
        writeJsonFileSpy = spyOn(fs, "writeJsonFile").mockResolvedValue(undefined);
        ensureDirectorySpy = spyOn(fs, "ensureDirectory").mockResolvedValue(undefined);
        getFileStatsSpy = spyOn(fs, "getFileStats").mockResolvedValue(null);

        // Mock fetch
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockModelsDevResponse),
        } as Response);
    });

    afterEach(() => {
        fetchSpy?.mockRestore();
        fileExistsSpy?.mockRestore();
        readJsonFileSpy?.mockRestore();
        writeJsonFileSpy?.mockRestore();
        ensureDirectorySpy?.mockRestore();
        getFileStatsSpy?.mockRestore();
        getConfigPathSpy?.mockRestore();
    });

    describe("getModelLimits", () => {
        test("returns undefined when cache is not loaded", () => {
            expect(getModelLimits("anthropic", "claude-opus-4-5-20251101")).toBeUndefined();
        });

        test("returns limits after cache is loaded", async () => {
            await ensureCacheLoaded();

            const limits = getModelLimits("anthropic", "claude-opus-4-5-20251101");

            expect(limits).toEqual({ context: 200000, output: 64000 });
        });

        test("returns undefined for unsupported providers", async () => {
            await ensureCacheLoaded();

            expect(getModelLimits("ollama", "llama3.2")).toBeUndefined();
            expect(getModelLimits("claude-code", "claude-sonnet")).toBeUndefined();
        });

        test("returns undefined for unknown models", async () => {
            await ensureCacheLoaded();

            expect(getModelLimits("anthropic", "unknown-model")).toBeUndefined();
        });
    });

    describe("getContextWindowFromModelsdev", () => {
        test("returns just the context window", async () => {
            await ensureCacheLoaded();

            expect(getContextWindowFromModelsdev("anthropic", "claude-opus-4-5-20251101")).toBe(200000);
            expect(getContextWindowFromModelsdev("openai", "gpt-4o")).toBe(128000);
        });

        test("returns undefined for unknown models", async () => {
            await ensureCacheLoaded();

            expect(getContextWindowFromModelsdev("anthropic", "unknown")).toBeUndefined();
        });
    });

    describe("ensureCacheLoaded", () => {
        test("fetches from API when no cache exists", async () => {
            await ensureCacheLoaded();

            expect(fetchSpy).toHaveBeenCalledWith("https://models.dev/api.json");
            expect(writeJsonFileSpy).toHaveBeenCalled();
        });

        test("loads from disk cache if available", async () => {
            fileExistsSpy.mockResolvedValue(true);
            readJsonFileSpy.mockResolvedValue({
                fetchedAt: Date.now(),
                data: mockModelsDevResponse,
            });
            // Return fresh stats (modified recently)
            getFileStatsSpy.mockResolvedValue({
                mtimeMs: Date.now(),
            });

            await ensureCacheLoaded();

            expect(readJsonFileSpy).toHaveBeenCalled();
            // Should still call fetch for initial loading since we don't have data yet
        });

        test("multiple calls don't trigger multiple fetches when cache is fresh", async () => {
            // First call loads the cache
            await ensureCacheLoaded();
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // Mock file stats to show cache is fresh (modified just now)
            getFileStatsSpy.mockResolvedValue({
                mtimeMs: Date.now(),
            });

            // Reset to track new calls
            fetchSpy.mockClear();

            // Second call should not fetch because cache is already loaded and fresh
            await ensureCacheLoaded();
            expect(fetchSpy).toHaveBeenCalledTimes(0);
        });
    });

    describe("clearModelsDevCache", () => {
        test("clears the in-memory cache", async () => {
            await ensureCacheLoaded();
            expect(getModelLimits("anthropic", "claude-opus-4-5-20251101")).toBeDefined();

            clearModelsDevCache();

            expect(getModelLimits("anthropic", "claude-opus-4-5-20251101")).toBeUndefined();
        });
    });

    describe("provider mapping", () => {
        test("maps anthropic correctly", async () => {
            await ensureCacheLoaded();
            expect(getModelLimits("anthropic", "claude-opus-4-5-20251101")).toBeDefined();
        });

        test("maps openai correctly", async () => {
            await ensureCacheLoaded();
            expect(getModelLimits("openai", "gpt-4o")).toBeDefined();
        });

        test("maps openrouter correctly", async () => {
            await ensureCacheLoaded();
            expect(getModelLimits("openrouter", "anthropic/claude-3-opus")).toBeDefined();
        });

        test("returns undefined for unmapped providers", async () => {
            await ensureCacheLoaded();
            expect(getModelLimits("custom-provider", "any-model")).toBeUndefined();
        });
    });
});
