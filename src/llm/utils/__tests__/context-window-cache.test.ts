import { describe, it, expect, beforeEach } from "vitest";
import { getContextWindow, clearCache } from "../context-window-cache";

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
});
