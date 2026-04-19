import { describe, expect, it } from "bun:test";
import { arraysEqual, arraysEqualUnordered } from "@/lib/arrays";

describe("arrays", () => {
    describe("arraysEqual", () => {
        it("should return true for identical arrays", () => {
            expect(arraysEqual(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
        });

        it("should return false for same elements in different order", () => {
            expect(arraysEqual(["a", "b", "c"], ["c", "a", "b"])).toBe(false);
        });

        it("should return false for different lengths", () => {
            expect(arraysEqual(["a", "b"], ["a", "b", "c"])).toBe(false);
        });

        it("should return false for different elements", () => {
            expect(arraysEqual(["a", "b"], ["a", "c"])).toBe(false);
        });

        it("should return true for empty arrays", () => {
            expect(arraysEqual([], [])).toBe(true);
        });
    });

    describe("arraysEqualUnordered", () => {
        it("should return true for same elements in same order", () => {
            expect(arraysEqualUnordered(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
        });

        it("should return true for same elements in different order", () => {
            expect(arraysEqualUnordered(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
        });

        it("should return false for different lengths", () => {
            expect(arraysEqualUnordered(["a", "b"], ["a", "b", "c"])).toBe(false);
        });

        it("should return false for different elements", () => {
            expect(arraysEqualUnordered(["a", "b"], ["a", "c"])).toBe(false);
        });

        it("should return true for empty arrays", () => {
            expect(arraysEqualUnordered([], [])).toBe(true);
        });
    });
});
