import { describe, expect, it } from "bun:test";
import { toKebabCase } from "@/lib/string";

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
