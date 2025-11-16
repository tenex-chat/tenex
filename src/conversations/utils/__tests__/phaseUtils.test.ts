import { describe, expect, it } from "vitest";
import {
    createPhaseTag,
    extractPhaseFromTags,
    filterDefinitionsByPhase,
    getPhaseCacheKey,
    isValidPhase,
    normalizePhase,
    phasesMatch,
    shouldUseDefinitionForPhase,
} from "../phaseUtils";

describe("phaseUtils", () => {
    describe("isValidPhase", () => {
        it("should return true for valid phase strings", () => {
            expect(isValidPhase("development")).toBe(true);
            expect(isValidPhase("testing")).toBe(true);
            expect(isValidPhase("PRODUCTION")).toBe(true);
            expect(isValidPhase("phase-1")).toBe(true);
        });

        it("should return false for invalid phases", () => {
            expect(isValidPhase(null)).toBe(false);
            expect(isValidPhase(undefined)).toBe(false);
            expect(isValidPhase("")).toBe(false);
            expect(isValidPhase("   ")).toBe(false);
            expect(isValidPhase("phase<script>")).toBe(false);
            expect(isValidPhase('phase"test')).toBe(false);
            expect(isValidPhase("phase>test")).toBe(false);
        });
    });

    describe("normalizePhase", () => {
        it("should normalize valid phases to lowercase trimmed strings", () => {
            expect(normalizePhase("DEVELOPMENT")).toBe("development");
            expect(normalizePhase("  Testing  ")).toBe("testing");
            expect(normalizePhase("Production")).toBe("production");
        });

        it("should return undefined for invalid phases", () => {
            expect(normalizePhase(null)).toBeUndefined();
            expect(normalizePhase(undefined)).toBeUndefined();
            expect(normalizePhase("")).toBeUndefined();
            expect(normalizePhase("phase<script>")).toBeUndefined();
        });
    });

    describe("phasesMatch", () => {
        it("should match identical phases (case-insensitive)", () => {
            expect(phasesMatch("development", "development")).toBe(true);
            expect(phasesMatch("DEVELOPMENT", "development")).toBe(true);
            expect(phasesMatch("  Testing  ", "testing")).toBe(true);
        });

        it("should not match different phases", () => {
            expect(phasesMatch("development", "testing")).toBe(false);
            expect(phasesMatch("production", "staging")).toBe(false);
        });

        it("should handle undefined phases", () => {
            expect(phasesMatch(undefined, undefined)).toBe(true); // Both undefined = match
            expect(phasesMatch("development", undefined)).toBe(false);
            expect(phasesMatch(undefined, "development")).toBe(false);
        });
    });

    describe("extractPhaseFromTags", () => {
        it("should extract phase from tags array", () => {
            const tags = [
                ["p", "pubkey123"],
                ["phase", "development"],
                ["tool", "delegate"],
            ];
            expect(extractPhaseFromTags(tags)).toBe("development");
        });

        it("should return undefined if no phase tag exists", () => {
            const tags = [
                ["p", "pubkey123"],
                ["tool", "delegate"],
            ];
            expect(extractPhaseFromTags(tags)).toBeUndefined();
        });

        it("should return first phase tag if multiple exist", () => {
            const tags = [
                ["phase", "development"],
                ["phase", "testing"], // Should be ignored
            ];
            expect(extractPhaseFromTags(tags)).toBe("development");
        });
    });

    describe("createPhaseTag", () => {
        it("should create phase tag for valid phase", () => {
            expect(createPhaseTag("development")).toEqual(["phase", "development"]);
            expect(createPhaseTag("  testing  ")).toEqual(["phase", "testing"]);
        });

        it("should return undefined for invalid phase", () => {
            expect(createPhaseTag(null)).toBeUndefined();
            expect(createPhaseTag(undefined)).toBeUndefined();
            expect(createPhaseTag("")).toBeUndefined();
            expect(createPhaseTag("phase<script>")).toBeUndefined();
        });
    });

    describe("filterDefinitionsByPhase", () => {
        const definitions = [
            { name: "Agent1", phase: "development" },
            { name: "Agent2", phase: "testing" },
            { name: "Agent3", phase: "production" },
            { name: "Agent4" }, // No phase (universal)
            { name: "Agent5", phase: "development" },
        ];

        it("should filter definitions by specific phase", () => {
            const result = filterDefinitionsByPhase(definitions, "development");
            expect(result).toHaveLength(3); // Agent1, Agent4 (universal), Agent5
            expect(result.map((d) => d.name)).toContain("Agent1");
            expect(result.map((d) => d.name)).toContain("Agent4");
            expect(result.map((d) => d.name)).toContain("Agent5");
        });

        it("should return only universal definitions when phase is undefined", () => {
            const result = filterDefinitionsByPhase(definitions, undefined);
            expect(result).toHaveLength(1); // Only Agent4
            expect(result[0].name).toBe("Agent4");
        });

        it("should handle case-insensitive phase matching", () => {
            const result = filterDefinitionsByPhase(definitions, "DEVELOPMENT");
            expect(result).toHaveLength(3);
            expect(result.map((d) => d.name)).toContain("Agent1");
            expect(result.map((d) => d.name)).toContain("Agent5");
        });

        it("should return empty array for invalid phase", () => {
            const result = filterDefinitionsByPhase(definitions, "phase<script>");
            expect(result).toHaveLength(0);
        });
    });

    describe("shouldUseDefinitionForPhase", () => {
        it("should use universal definitions (no phase) for any request", () => {
            expect(shouldUseDefinitionForPhase(undefined, "development")).toBe(true);
            expect(shouldUseDefinitionForPhase(undefined, "testing")).toBe(true);
            expect(shouldUseDefinitionForPhase(undefined, undefined)).toBe(true);
        });

        it("should not use phase-specific definitions for requests without phase", () => {
            expect(shouldUseDefinitionForPhase("development", undefined)).toBe(false);
            expect(shouldUseDefinitionForPhase("testing", undefined)).toBe(false);
        });

        it("should use definitions when phases match", () => {
            expect(shouldUseDefinitionForPhase("development", "development")).toBe(true);
            expect(shouldUseDefinitionForPhase("TESTING", "testing")).toBe(true);
        });

        it("should not use definitions when phases don't match", () => {
            expect(shouldUseDefinitionForPhase("development", "testing")).toBe(false);
            expect(shouldUseDefinitionForPhase("production", "staging")).toBe(false);
        });
    });

    describe("getPhaseCacheKey", () => {
        it("should include phase in cache key when phase is provided", () => {
            expect(getPhaseCacheKey("agent:123", "development")).toBe(
                "agent:123:phase:development"
            );
            expect(getPhaseCacheKey("definition:456", "TESTING")).toBe(
                "definition:456:phase:testing"
            );
        });

        it("should return base key when phase is not provided", () => {
            expect(getPhaseCacheKey("agent:123", undefined)).toBe("agent:123");
            expect(getPhaseCacheKey("definition:456", null)).toBe("definition:456");
        });

        it("should return base key for invalid phase", () => {
            expect(getPhaseCacheKey("agent:123", "")).toBe("agent:123");
            expect(getPhaseCacheKey("agent:123", "phase<script>")).toBe("agent:123");
        });

        it("should normalize phase in cache key", () => {
            expect(getPhaseCacheKey("agent:123", "  DEVELOPMENT  ")).toBe(
                "agent:123:phase:development"
            );
        });
    });
});
