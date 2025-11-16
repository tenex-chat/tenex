import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { resolveAndValidatePath } from "../utils";

describe("resolveAndValidatePath", () => {
    const projectPath = "/test/project";

    it("should resolve relative paths within project", () => {
        const result = resolveAndValidatePath("src/file.ts", projectPath);
        expect(result).toBe(resolve(projectPath, "src/file.ts"));
    });

    it("should accept absolute paths within project", () => {
        const validPath = "/test/project/src/file.ts";
        const result = resolveAndValidatePath(validPath, projectPath);
        expect(result).toBe(validPath);
    });

    it("should throw error for paths outside project", () => {
        expect(() => resolveAndValidatePath("../../outside.ts", projectPath)).toThrow(
            "Path outside project directory"
        );
    });

    it("should throw error for absolute paths outside project", () => {
        const outsidePath = "/other/project/file.ts";
        expect(() => resolveAndValidatePath(outsidePath, projectPath)).toThrow(
            "Path outside project directory"
        );
    });

    it("should handle nested relative paths", () => {
        const result = resolveAndValidatePath("./src/../lib/file.ts", projectPath);
        expect(result).toBe(resolve(projectPath, "lib/file.ts"));
    });

    it("should handle paths with no extension", () => {
        const result = resolveAndValidatePath("src/folder", projectPath);
        expect(result).toBe(resolve(projectPath, "src/folder"));
    });
});
