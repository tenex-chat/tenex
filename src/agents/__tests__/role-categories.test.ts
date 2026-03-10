import { describe, expect, it } from "bun:test";
import {
    VALID_CATEGORIES,
    isValidCategory,
    isKnownCategory,
    resolveCategory,
} from "../role-categories";

describe("role-categories", () => {
    describe("VALID_CATEGORIES", () => {
        it("should contain exactly 6 categories", () => {
            expect(VALID_CATEGORIES).toHaveLength(6);
        });

        it("should include all expected categories", () => {
            expect(VALID_CATEGORIES).toContain("principal");
            expect(VALID_CATEGORIES).toContain("orchestrator");
            expect(VALID_CATEGORIES).toContain("worker");
            expect(VALID_CATEGORIES).toContain("reviewer");
            expect(VALID_CATEGORIES).toContain("domain-expert");
            expect(VALID_CATEGORIES).toContain("generalist");
        });

        it("should not contain removed categories", () => {
            expect(VALID_CATEGORIES).not.toContain("executor");
            expect(VALID_CATEGORIES).not.toContain("expert");
            expect(VALID_CATEGORIES).not.toContain("advisor");
            expect(VALID_CATEGORIES).not.toContain("creator");
            expect(VALID_CATEGORIES).not.toContain("assistant");
            expect(VALID_CATEGORIES).not.toContain("auditor");
        });
    });

    describe("isValidCategory", () => {
        it("should return true for all current categories", () => {
            expect(isValidCategory("principal")).toBe(true);
            expect(isValidCategory("orchestrator")).toBe(true);
            expect(isValidCategory("worker")).toBe(true);
            expect(isValidCategory("reviewer")).toBe(true);
            expect(isValidCategory("domain-expert")).toBe(true);
            expect(isValidCategory("generalist")).toBe(true);
        });

        it("should return false for legacy categories (use isKnownCategory instead)", () => {
            expect(isValidCategory("executor")).toBe(false);
            expect(isValidCategory("expert")).toBe(false);
            expect(isValidCategory("advisor")).toBe(false);
            expect(isValidCategory("creator")).toBe(false);
            expect(isValidCategory("assistant")).toBe(false);
        });

        it("should return false for invalid categories", () => {
            expect(isValidCategory("unknown")).toBe(false);
            expect(isValidCategory("")).toBe(false);
            expect(isValidCategory("manager")).toBe(false);
            expect(isValidCategory("auditor")).toBe(false);
        });

        it("should reject prototype-polluted keys", () => {
            expect(isValidCategory("toString")).toBe(false);
            expect(isValidCategory("__proto__")).toBe(false);
            expect(isValidCategory("constructor")).toBe(false);
            expect(isValidCategory("hasOwnProperty")).toBe(false);
        });

        it("should be case-sensitive", () => {
            expect(isValidCategory("Principal")).toBe(false);
            expect(isValidCategory("WORKER")).toBe(false);
            expect(isValidCategory("Domain-Expert")).toBe(false);
        });
    });

    describe("isKnownCategory", () => {
        it("should return true for all current categories", () => {
            expect(isKnownCategory("principal")).toBe(true);
            expect(isKnownCategory("orchestrator")).toBe(true);
            expect(isKnownCategory("worker")).toBe(true);
            expect(isKnownCategory("reviewer")).toBe(true);
            expect(isKnownCategory("domain-expert")).toBe(true);
            expect(isKnownCategory("generalist")).toBe(true);
        });

        it("should return true for legacy categories", () => {
            expect(isKnownCategory("executor")).toBe(true);
            expect(isKnownCategory("expert")).toBe(true);
            expect(isKnownCategory("advisor")).toBe(true);
            expect(isKnownCategory("creator")).toBe(true);
            expect(isKnownCategory("assistant")).toBe(true);
        });

        it("should return false for unknown categories", () => {
            expect(isKnownCategory("unknown")).toBe(false);
            expect(isKnownCategory("")).toBe(false);
            expect(isKnownCategory("manager")).toBe(false);
            expect(isKnownCategory("auditor")).toBe(false);
        });

        it("should reject prototype-polluted keys", () => {
            expect(isKnownCategory("toString")).toBe(false);
            expect(isKnownCategory("__proto__")).toBe(false);
            expect(isKnownCategory("constructor")).toBe(false);
            expect(isKnownCategory("hasOwnProperty")).toBe(false);
        });
    });

    describe("resolveCategory", () => {
        it("should return the category when it is a current valid category", () => {
            expect(resolveCategory("principal")).toBe("principal");
            expect(resolveCategory("orchestrator")).toBe("orchestrator");
            expect(resolveCategory("worker")).toBe("worker");
            expect(resolveCategory("reviewer")).toBe("reviewer");
            expect(resolveCategory("domain-expert")).toBe("domain-expert");
            expect(resolveCategory("generalist")).toBe("generalist");
        });

        it("should migrate legacy categories to new taxonomy", () => {
            expect(resolveCategory("executor")).toBe("worker");
            expect(resolveCategory("expert")).toBe("domain-expert");
            expect(resolveCategory("advisor")).toBe("reviewer");
            expect(resolveCategory("creator")).toBe("generalist");
            expect(resolveCategory("assistant")).toBe("generalist");
        });

        it("should return undefined for undefined input", () => {
            expect(resolveCategory(undefined)).toBeUndefined();
        });

        it("should return undefined for unrecognized strings", () => {
            expect(resolveCategory("unknown")).toBeUndefined();
            expect(resolveCategory("developer")).toBeUndefined();
            expect(resolveCategory("")).toBeUndefined();
        });

        it("should return undefined for truly removed categories", () => {
            expect(resolveCategory("auditor")).toBeUndefined();
        });

        it("should be case-sensitive", () => {
            expect(resolveCategory("Principal")).toBeUndefined();
            expect(resolveCategory("WORKER")).toBeUndefined();
            expect(resolveCategory("Domain-Expert")).toBeUndefined();
        });

        it("should return undefined for prototype-polluted keys", () => {
            expect(resolveCategory("toString")).toBeUndefined();
            expect(resolveCategory("__proto__")).toBeUndefined();
            expect(resolveCategory("constructor")).toBeUndefined();
            expect(resolveCategory("hasOwnProperty")).toBeUndefined();
        });
    });
});
