import { describe, test, expect } from "bun:test";
import { getDefaultProviderOptions, mergeProviderOptions } from "../provider-options";

describe("getDefaultProviderOptions", () => {
    test("enables Anthropic automatic prompt caching by default", () => {
        expect(getDefaultProviderOptions("anthropic")).toEqual({
            anthropic: {
                cacheControl: { type: "ephemeral" },
            },
        });
    });

    test("returns undefined for non-Anthropic providers", () => {
        expect(getDefaultProviderOptions("openrouter")).toBeUndefined();
    });
});

describe("mergeProviderOptions", () => {
    test("returns extra when base is undefined", () => {
        const extra = { anthropic: { cacheControl: true } };
        expect(mergeProviderOptions(undefined, extra)).toEqual(extra);
    });

    test("returns base when extra is undefined", () => {
        const base = { openrouter: { model: "x" } };
        expect(mergeProviderOptions(base, undefined)).toEqual(base);
    });

    test("returns undefined when both are undefined", () => {
        expect(mergeProviderOptions(undefined, undefined)).toBeUndefined();
    });

    test("shallow merges top-level provider keys", () => {
        const base = { openrouter: { model: "x" } };
        const extra = { anthropic: { cacheControl: true } };
        expect(mergeProviderOptions(base, extra)).toEqual({
            openrouter: { model: "x" },
            anthropic: { cacheControl: true },
        });
    });

    test("deep merges nested provider objects", () => {
        const base = { anthropic: { model: "claude", temperature: 0.5 } };
        const extra = { anthropic: { cacheControl: true } };
        expect(mergeProviderOptions(base, extra)).toEqual({
            anthropic: { model: "claude", temperature: 0.5, cacheControl: true },
        });
    });

    test("extra values override base values in nested merge", () => {
        const base = { anthropic: { model: "old" } };
        const extra = { anthropic: { model: "new" } };
        expect(mergeProviderOptions(base, extra)).toEqual({
            anthropic: { model: "new" },
        });
    });

    test("non-object extra value overwrites base object", () => {
        const base = { provider: { key: "value" } };
        const extra = { provider: "override" };
        expect(mergeProviderOptions(base, extra)).toEqual({
            provider: "override",
        });
    });
});
