import { describe, test, expect } from "bun:test";
import {
    isErrorTextResult,
    unwrapErrorTextResult,
    buildOutsideWorkingDirectoryMessage,
    adaptOutsideWorkingDirectoryText,
    adaptOutsideWorkingDirectoryResult,
    assertAbsolutePath,
    formatRelativePathMessage,
    normalizeGrepFallbackOutput,
} from "../fs-tool-adapter";

describe("isErrorTextResult", () => {
    test("returns true for valid ErrorTextResult", () => {
        expect(isErrorTextResult({ type: "error-text", text: "some error" })).toBe(true);
    });

    test("returns false for plain string", () => {
        expect(isErrorTextResult("some error")).toBe(false);
    });

    test("returns false for null/undefined", () => {
        expect(isErrorTextResult(null)).toBe(false);
        expect(isErrorTextResult(undefined)).toBe(false);
    });

    test("returns false for object with wrong type", () => {
        expect(isErrorTextResult({ type: "success", text: "ok" })).toBe(false);
    });

    test("returns false for object missing text", () => {
        expect(isErrorTextResult({ type: "error-text" })).toBe(false);
    });
});

describe("unwrapErrorTextResult", () => {
    test("extracts text from ErrorTextResult", () => {
        expect(unwrapErrorTextResult({ type: "error-text", text: "error msg" })).toBe("error msg");
    });

    test("returns plain string as-is", () => {
        expect(unwrapErrorTextResult("plain string")).toBe("plain string");
    });
});

describe("buildOutsideWorkingDirectoryMessage", () => {
    test("includes path and working directory", () => {
        const msg = buildOutsideWorkingDirectoryMessage("/etc/passwd", "/home/user/project");
        expect(msg).toContain("/etc/passwd");
        expect(msg).toContain("/home/user/project");
        expect(msg).toContain("allowOutsideWorkingDirectory: true");
    });
});

describe("adaptOutsideWorkingDirectoryText", () => {
    test("rewrites message containing 'outside the configured roots'", () => {
        const result = adaptOutsideWorkingDirectoryText(
            "Path /etc/passwd is outside the configured roots",
            "/etc/passwd",
            "/home/user"
        );
        expect(result).toContain("outside your working directory");
        expect(result).not.toContain("configured roots");
    });

    test("passes through unrelated error messages", () => {
        const original = "File not found";
        const result = adaptOutsideWorkingDirectoryText(original, "/some/path", "/home/user");
        expect(result).toBe(original);
    });
});

describe("adaptOutsideWorkingDirectoryResult", () => {
    test("rewrites ErrorTextResult containing 'outside the configured roots'", () => {
        const result = adaptOutsideWorkingDirectoryResult(
            { type: "error-text", text: "Path is outside the configured roots" },
            "/etc/passwd",
            "/home/user"
        );
        expect(typeof result).toBe("string");
        expect(result).toContain("outside your working directory");
    });

    test("passes through ErrorTextResult without matching text", () => {
        const original = { type: "error-text" as const, text: "File not found" };
        const result = adaptOutsideWorkingDirectoryResult(original, "/some/path", "/home/user");
        expect(result).toEqual(original);
    });

    test("rewrites plain string containing 'outside the configured roots'", () => {
        const result = adaptOutsideWorkingDirectoryResult(
            "Path is outside the configured roots",
            "/etc/passwd",
            "/home/user"
        );
        expect(typeof result).toBe("string");
        expect(result).toContain("outside your working directory");
    });

    test("passes through plain string without matching text", () => {
        const result = adaptOutsideWorkingDirectoryResult(
            "Some other error",
            "/some/path",
            "/home/user"
        );
        expect(result).toBe("Some other error");
    });
});

describe("assertAbsolutePath", () => {
    test("does not throw for absolute path", () => {
        expect(() => assertAbsolutePath("/usr/bin")).not.toThrow();
    });

    test("throws for relative path", () => {
        expect(() => assertAbsolutePath("relative/path")).toThrow("Path must be absolute");
    });
});

describe("formatRelativePathMessage", () => {
    test("includes the path", () => {
        expect(formatRelativePathMessage("foo/bar")).toContain("foo/bar");
    });
});

describe("normalizeGrepFallbackOutput", () => {
    test("rewrites byte-count overflow message", () => {
        const input = "Content output would exceed 50000 bytes (actual: 123456).\nShowing matching files instead (42 total):\n\nfile1.ts\nfile2.ts";
        const result = normalizeGrepFallbackOutput(input);
        expect(result).toContain("Content output would exceed 50KB limit.");
        expect(result).toContain("Returning matching files instead:");
        expect(result).toContain("file1.ts");
        expect(result).not.toContain("actual: 123456");
    });

    test("rewrites buffer overflow message", () => {
        const input = "Content output exceeded the command buffer.\nShowing matching files instead (10 total):\n\nfile.ts";
        const result = normalizeGrepFallbackOutput(input);
        expect(result).toContain("Content output would exceed 50KB limit.");
        expect(result).toContain("file.ts");
    });

    test("passes through normal output", () => {
        const input = "match1\nmatch2\n";
        expect(normalizeGrepFallbackOutput(input)).toBe(input);
    });

    test("truncates output exceeding 50KB", () => {
        const longOutput = "x".repeat(60_000);
        const result = normalizeGrepFallbackOutput(longOutput);
        expect(Buffer.from(result, "utf8").length).toBeLessThanOrEqual(50_000);
    });
});
