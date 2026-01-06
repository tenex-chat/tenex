import { describe, expect, it } from "bun:test";
import {
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
});
