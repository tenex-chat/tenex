import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
    createExpectedError,
    getFsErrorDescription,
    isExpectedFsError,
    isExpectedHttpError,
    isExpectedNotFoundError,
    resolveAndValidatePath,
} from "../utils";

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

// =============================================================================
// Expected Error Handling Contract Tests
// =============================================================================

describe("isExpectedFsError", () => {
    it("should return true for ENOENT (file not found)", () => {
        const error = new Error("File not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        expect(isExpectedFsError(error)).toBe(true);
    });

    it("should return true for EACCES (permission denied)", () => {
        const error = new Error("Permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        expect(isExpectedFsError(error)).toBe(true);
    });

    it("should return true for EISDIR (is a directory)", () => {
        const error = new Error("Is a directory") as NodeJS.ErrnoException;
        error.code = "EISDIR";
        expect(isExpectedFsError(error)).toBe(true);
    });

    it("should return true for EPERM (operation not permitted)", () => {
        const error = new Error("Operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        expect(isExpectedFsError(error)).toBe(true);
    });

    it("should return true for ENOTDIR (not a directory)", () => {
        const error = new Error("Not a directory") as NodeJS.ErrnoException;
        error.code = "ENOTDIR";
        expect(isExpectedFsError(error)).toBe(true);
    });

    it("should return false for errors without a code", () => {
        const error = new Error("Some other error");
        expect(isExpectedFsError(error)).toBe(false);
    });

    it("should return false for unexpected error codes", () => {
        const error = new Error("Connection refused") as NodeJS.ErrnoException;
        error.code = "ECONNREFUSED";
        expect(isExpectedFsError(error)).toBe(false);
    });

    it("should return false for non-Error objects", () => {
        expect(isExpectedFsError("not an error")).toBe(false);
        expect(isExpectedFsError(null)).toBe(false);
        expect(isExpectedFsError(undefined)).toBe(false);
        expect(isExpectedFsError({ code: "ENOENT" })).toBe(false);
    });
});

describe("isExpectedHttpError", () => {
    it("should return true for 404 Not Found", () => {
        expect(isExpectedHttpError(404)).toBe(true);
    });

    it("should return true for 401 Unauthorized", () => {
        expect(isExpectedHttpError(401)).toBe(true);
    });

    it("should return true for 403 Forbidden", () => {
        expect(isExpectedHttpError(403)).toBe(true);
    });

    it("should return true for 400 Bad Request", () => {
        expect(isExpectedHttpError(400)).toBe(true);
    });

    it("should return true for 429 Too Many Requests", () => {
        expect(isExpectedHttpError(429)).toBe(true);
    });

    it("should return false for 500 Internal Server Error", () => {
        expect(isExpectedHttpError(500)).toBe(false);
    });

    it("should return false for 503 Service Unavailable", () => {
        expect(isExpectedHttpError(503)).toBe(false);
    });

    it("should return false for 200 OK", () => {
        expect(isExpectedHttpError(200)).toBe(false);
    });
});

describe("isExpectedNotFoundError", () => {
    it("should return true for 'not found' messages", () => {
        expect(isExpectedNotFoundError(new Error("Resource not found"))).toBe(true);
        expect(isExpectedNotFoundError(new Error("Event not found"))).toBe(true);
        expect(isExpectedNotFoundError(new Error("NOT FOUND"))).toBe(true);
    });

    it("should return true for 'does not exist' messages", () => {
        expect(isExpectedNotFoundError(new Error("File does not exist"))).toBe(true);
    });

    it("should return true for 'no such' messages", () => {
        expect(isExpectedNotFoundError(new Error("No such file or directory"))).toBe(true);
    });

    it("should return true for 'cannot find' messages", () => {
        expect(isExpectedNotFoundError(new Error("Cannot find module"))).toBe(true);
    });

    it("should return false for other error messages", () => {
        expect(isExpectedNotFoundError(new Error("Connection refused"))).toBe(false);
        expect(isExpectedNotFoundError(new Error("Timeout"))).toBe(false);
    });

    it("should return false for non-Error objects", () => {
        expect(isExpectedNotFoundError("not found")).toBe(false);
        expect(isExpectedNotFoundError(null)).toBe(false);
    });
});

describe("createExpectedError", () => {
    it("should create error-text object with correct structure", () => {
        const result = createExpectedError("File not found: /path/to/file");
        expect(result).toEqual({
            type: "error-text",
            text: "File not found: /path/to/file",
        });
    });

    it("should preserve the exact message", () => {
        const message = "Custom error message with special chars: <>&\"'";
        const result = createExpectedError(message);
        expect(result.text).toBe(message);
    });
});

describe("getFsErrorDescription", () => {
    it("should return human-readable description for ENOENT", () => {
        expect(getFsErrorDescription("ENOENT")).toBe("File or directory not found");
    });

    it("should return human-readable description for EACCES", () => {
        expect(getFsErrorDescription("EACCES")).toBe("Permission denied");
    });

    it("should return human-readable description for EISDIR", () => {
        expect(getFsErrorDescription("EISDIR")).toBe("Expected a file but found a directory");
    });

    it("should return human-readable description for EPERM", () => {
        expect(getFsErrorDescription("EPERM")).toBe("Operation not permitted");
    });

    it("should return human-readable description for ENOTDIR", () => {
        expect(getFsErrorDescription("ENOTDIR")).toBe("Expected a directory but found a file");
    });

    it("should return generic description for unknown codes", () => {
        expect(getFsErrorDescription("ECONNREFUSED")).toBe("Filesystem error");
        expect(getFsErrorDescription(undefined)).toBe("Filesystem error");
    });
});
