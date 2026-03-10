import { describe, expect, it } from "bun:test";
import {
    VALID_CATEGORIES,
    isValidCategory,
    resolveCategory,
} from "../role-categories";

describe("role-categories", () => {
    describe("VALID_CATEGORIES", () => {
        it("should contain exactly 7 categories", () => {
            expect(VALID_CATEGORIES).toHaveLength(7);
        });

        it("should include all expected categories", () => {
            expect(VALID_CATEGORIES).toContain("principal");
            expect(VALID_CATEGORIES).toContain("orchestrator");
            expect(VALID_CATEGORIES).toContain("executor");
            expect(VALID_CATEGORIES).toContain("expert");
            expect(VALID_CATEGORIES).toContain("advisor");
            expect(VALID_CATEGORIES).toContain("creator");
            expect(VALID_CATEGORIES).toContain("assistant");
        });

        it("should not contain removed categories", () => {
            expect(VALID_CATEGORIES).not.toContain("worker");
            expect(VALID_CATEGORIES).not.toContain("auditor");
        });
    });

    describe("isValidCategory", () => {
        it("should return true for all valid categories", () => {
            expect(isValidCategory("principal")).toBe(true);
            expect(isValidCategory("orchestrator")).toBe(true);
            expect(isValidCategory("executor")).toBe(true);
            expect(isValidCategory("expert")).toBe(true);
            expect(isValidCategory("advisor")).toBe(true);
            expect(isValidCategory("creator")).toBe(true);
            expect(isValidCategory("assistant")).toBe(true);
        });

        it("should return false for invalid categories", () => {
            expect(isValidCategory("unknown")).toBe(false);
            expect(isValidCategory("")).toBe(false);
            expect(isValidCategory("manager")).toBe(false);
        });

        it("should return false for removed categories", () => {
            expect(isValidCategory("worker")).toBe(false);
            expect(isValidCategory("auditor")).toBe(false);
        });

        it("should be case-sensitive", () => {
            expect(isValidCategory("Principal")).toBe(false);
            expect(isValidCategory("EXECUTOR")).toBe(false);
            expect(isValidCategory("Expert")).toBe(false);
        });
    });

    describe("resolveCategory", () => {
        it("should return the category when it is valid", () => {
            expect(resolveCategory("principal")).toBe("principal");
            expect(resolveCategory("orchestrator")).toBe("orchestrator");
            expect(resolveCategory("executor")).toBe("executor");
            expect(resolveCategory("expert")).toBe("expert");
            expect(resolveCategory("advisor")).toBe("advisor");
            expect(resolveCategory("creator")).toBe("creator");
            expect(resolveCategory("assistant")).toBe("assistant");
        });

        it("should return undefined for undefined input", () => {
            expect(resolveCategory(undefined)).toBeUndefined();
        });

        it("should return undefined for unrecognized strings", () => {
            expect(resolveCategory("unknown")).toBeUndefined();
            expect(resolveCategory("developer")).toBeUndefined();
            expect(resolveCategory("")).toBeUndefined();
        });

        it("should return undefined for removed categories", () => {
            expect(resolveCategory("worker")).toBeUndefined();
            expect(resolveCategory("auditor")).toBeUndefined();
        });

        it("should be case-sensitive", () => {
            expect(resolveCategory("Principal")).toBeUndefined();
            expect(resolveCategory("EXECUTOR")).toBeUndefined();
            expect(resolveCategory("Expert")).toBeUndefined();
        });
    });
});
