import { describe, expect, it } from "bun:test";
import { slugifyIdentifier, toKebabCase } from "@/lib/string";

describe("toKebabCase", () => {
    it("should convert camelCase to kebab-case", () => {
        expect(toKebabCase("camelCase")).toBe("camel-case");
        expect(toKebabCase("someVariableName")).toBe("some-variable-name");
    });

    it("should convert PascalCase to kebab-case", () => {
        expect(toKebabCase("PascalCase")).toBe("pascal-case");
        expect(toKebabCase("MyComponentName")).toBe("my-component-name");
    });

    it("should handle spaces", () => {
        expect(toKebabCase("some words here")).toBe("some-words-here");
        expect(toKebabCase("multiple   spaces")).toBe("multiple-spaces");
    });

    it("should handle underscores", () => {
        expect(toKebabCase("snake_case")).toBe("snake-case");
        expect(toKebabCase("CONSTANT_NAME")).toBe("constant-name");
    });

    it("should handle mixed formats", () => {
        expect(toKebabCase("mixedCase_with spaces")).toBe("mixed-case-with-spaces");
        expect(toKebabCase("PascalCase_snake_case")).toBe("pascal-case-snake-case");
    });

    it("should handle already kebab-case strings", () => {
        expect(toKebabCase("already-kebab-case")).toBe("already-kebab-case");
    });

    it("should handle empty strings", () => {
        expect(toKebabCase("")).toBe("");
    });

    it("should handle single characters", () => {
        expect(toKebabCase("a")).toBe("a");
        expect(toKebabCase("A")).toBe("a");
    });
});

describe("slugifyIdentifier", () => {
    it("should strip punctuation and normalize whitespace", () => {
        expect(slugifyIdentifier("Make Poster! (v2)")).toBe("make-poster-v2");
    });

    it("should normalize accented characters", () => {
        expect(slugifyIdentifier("Crème Brûlée")).toBe("creme-brulee");
    });

    it("should collapse repeated separators", () => {
        expect(slugifyIdentifier("foo___bar   baz")).toBe("foo-bar-baz");
    });

    it("should return empty string when no slug characters remain", () => {
        expect(slugifyIdentifier("!!!")).toBe("");
    });
});
