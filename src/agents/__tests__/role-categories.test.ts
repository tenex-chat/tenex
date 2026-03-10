import { describe, expect, it } from "bun:test";
import {
    VALID_CATEGORIES,
    isValidCategory,
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

        it("should return false for invalid categories", () => {
            expect(isValidCategory("unknown")).toBe(false);
            expect(isValidCategory("")).toBe(false);
            expect(isValidCategory("manager")).toBe(false);
            expect(isValidCategory("auditor")).toBe(false);
        });

        it("should be case-sensitive", () => {
            expect(isValidCategory("Principal")).toBe(false);
            expect(isValidCategory("WORKER")).toBe(false);
            expect(isValidCategory("Domain-Expert")).toBe(false);
        });
    });

    describe("resolveCategory", () => {
        it("should return the category when it is a valid category", () => {
            expect(resolveCategory("principal")).toBe("principal");
            expect(resolveCategory("orchestrator")).toBe("orchestrator");
            expect(resolveCategory("worker")).toBe("worker");
            expect(resolveCategory("reviewer")).toBe("reviewer");
            expect(resolveCategory("domain-expert")).toBe("domain-expert");
            expect(resolveCategory("generalist")).toBe("generalist");
        });

        it("should return undefined for undefined input", () => {
            expect(resolveCategory(undefined)).toBeUndefined();
        });

        it("should return undefined for unrecognized strings", () => {
            expect(resolveCategory("unknown")).toBeUndefined();
            expect(resolveCategory("developer")).toBeUndefined();
            expect(resolveCategory("")).toBeUndefined();
        });

        it("should be case-sensitive", () => {
            expect(resolveCategory("Principal")).toBeUndefined();
            expect(resolveCategory("WORKER")).toBeUndefined();
            expect(resolveCategory("Domain-Expert")).toBeUndefined();
        });
    });
});
