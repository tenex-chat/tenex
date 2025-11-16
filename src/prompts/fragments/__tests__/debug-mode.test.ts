import { describe, expect, it } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { debugModeFragment, isDebugMode } from "../debug-mode";

describe("debugModeFragment", () => {
    it("should return empty string when disabled", () => {
        const result = debugModeFragment.template({ enabled: false });
        expect(result).toBe("");
    });

    it("should return debug instructions when enabled", () => {
        const result = debugModeFragment.template({ enabled: true });
        expect(result).toContain("DEBUG MODE: META-COGNITIVE ANALYSIS REQUESTED");
        expect(result).toContain("System Prompt Influence");
        expect(result).toContain("Reasoning Chain");
        expect(result).toContain("Alternatives Considered");
        expect(result).toContain("Assumptions Made");
        expect(result).toContain("Constraints Applied");
        expect(result).toContain("Confidence Level");
        expect(result).toContain("Pattern Matching");
    });
});

describe("isDebugMode", () => {
    it("should return true when event contains #debug", () => {
        const event: Partial<NDKEvent> = {
            content: "This is a test message with #debug flag",
        };
        expect(isDebugMode(event as NDKEvent)).toBe(true);
    });

    it("should return false when event does not contain #debug", () => {
        const event: Partial<NDKEvent> = {
            content: "This is a normal message",
        };
        expect(isDebugMode(event as NDKEvent)).toBe(false);
    });

    it("should return false when event is undefined", () => {
        expect(isDebugMode(undefined)).toBe(false);
    });

    it("should return false when event content is undefined", () => {
        const event: Partial<NDKEvent> = {
            content: undefined,
        };
        expect(isDebugMode(event as NDKEvent)).toBe(false);
    });
});
