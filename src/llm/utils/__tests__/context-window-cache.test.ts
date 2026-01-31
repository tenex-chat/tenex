import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { getContextWindow, clearCache, resolveContextWindow } from "../context-window-cache";
import * as modelsDevCache from "../models-dev-cache";

describe("context-window-cache", () => {
    describe("getContextWindow", () => {
        test("delegates to getContextWindowFromModelsdev", () => {
            const spy = spyOn(modelsDevCache, "getContextWindowFromModelsdev").mockReturnValue(200000);

            const result = getContextWindow("anthropic", "claude-opus-4-5-20251101");

            expect(spy).toHaveBeenCalledWith("anthropic", "claude-opus-4-5-20251101");
            expect(result).toBe(200000);

            spy.mockRestore();
        });

        test("returns undefined when model not found", () => {
            const spy = spyOn(modelsDevCache, "getContextWindowFromModelsdev").mockReturnValue(undefined);

            const result = getContextWindow("unknown", "unknown-model");

            expect(result).toBeUndefined();

            spy.mockRestore();
        });
    });

    describe("resolveContextWindow", () => {
        test("is a no-op (models-dev-cache handles loading at startup)", async () => {
            // resolveContextWindow should complete without error
            await resolveContextWindow("anthropic", "claude-opus-4-5-20251101");
            // No assertion needed - just verify it doesn't throw
        });
    });

    describe("clearCache", () => {
        test("delegates to clearModelsDevCache", () => {
            const spy = spyOn(modelsDevCache, "clearModelsDevCache").mockImplementation(() => {});

            clearCache();

            expect(spy).toHaveBeenCalled();

            spy.mockRestore();
        });
    });
});
