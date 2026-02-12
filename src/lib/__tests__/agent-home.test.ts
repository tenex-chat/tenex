import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
    getAgentHomeDirectory,
    getAgentHomeInjectedFiles,
    HomeScopeViolationError,
    isPathWithinDirectory,
    isWithinAgentHome,
    normalizePath,
    resolveHomeScopedPath,
} from "../agent-home";

// Mock the constants to use a temp path that doesn't affect other tests
const TEST_BASE_PATH = "/tmp/tenex-test";
mock.module("@/constants", () => ({
    getTenexBasePath: () => TEST_BASE_PATH,
}));

describe("agent-home utilities", () => {
    describe("normalizePath", () => {
        it("should resolve relative path components", () => {
            const result = normalizePath("/home/user/../admin/file.txt");
            expect(result).toBe("/home/admin/file.txt");
        });

        it("should handle current directory dots", () => {
            const result = normalizePath("/home/./user/./file.txt");
            expect(result).toBe("/home/user/file.txt");
        });

        it("should handle multiple parent directory traversals", () => {
            const result = normalizePath("/home/user/docs/../../admin/file.txt");
            expect(result).toBe("/home/admin/file.txt");
        });

        it("should handle redundant slashes", () => {
            const result = normalizePath("/home//user///file.txt");
            expect(result).toBe("/home/user/file.txt");
        });
    });

    describe("isPathWithinDirectory", () => {
        it("should return true for paths inside directory", () => {
            expect(isPathWithinDirectory("/home/user/docs/file.txt", "/home/user")).toBe(true);
        });

        it("should return true for exact directory match", () => {
            expect(isPathWithinDirectory("/home/user", "/home/user")).toBe(true);
        });

        it("should return false for paths outside directory", () => {
            expect(isPathWithinDirectory("/home/admin/file.txt", "/home/user")).toBe(false);
        });

        it("should prevent path traversal attacks with ..", () => {
            // Attempt to escape using ..
            expect(isPathWithinDirectory("/home/user/../admin/file.txt", "/home/user")).toBe(false);
        });

        it("should prevent prefix-only matching attacks", () => {
            // /home/username should NOT be within /home/user
            expect(isPathWithinDirectory("/home/username/file.txt", "/home/user")).toBe(false);
        });

        it("should handle complex traversal attempts", () => {
            // Multiple traversals trying to escape
            expect(isPathWithinDirectory("/project/src/../../etc/passwd", "/project")).toBe(false);
        });

        it("should handle paths with trailing slashes", () => {
            expect(isPathWithinDirectory("/home/user/docs/", "/home/user/")).toBe(true);
        });
    });

    describe("isWithinAgentHome", () => {
        const testPubkey = "abcd1234567890ef";

        it("should return true for files in agent home", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            expect(isWithinAgentHome(`${homeDir}/notes.txt`, testPubkey)).toBe(true);
        });

        it("should return true for exact home directory match", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            expect(isWithinAgentHome(homeDir, testPubkey)).toBe(true);
        });

        it("should return false for files outside agent home", () => {
            expect(isWithinAgentHome("/etc/passwd", testPubkey)).toBe(false);
        });

        it("should prevent traversal attacks trying to escape home", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            // Attempt to escape agent home using ..
            expect(isWithinAgentHome(`${homeDir}/../other-agent/file.txt`, testPubkey)).toBe(false);
        });

        it("should share home directory for same 8-char prefix (by design)", () => {
            // Agents with pubkeys sharing the same first 8 characters share a home directory
            // This is expected behavior since home dir is derived from first 8 chars
            const samePrefix = getAgentHomeDirectory("abcd1234different");
            expect(isWithinAgentHome(`${samePrefix}/file.txt`, testPubkey)).toBe(true);
        });

        it("should prevent access to different 8-char prefix homes", () => {
            // Agent with different first 8 chars should NOT access testPubkey's home
            expect(isWithinAgentHome(`${TEST_BASE_PATH}/home/different/file.txt`, testPubkey)).toBe(false);
        });
    });

    describe("getAgentHomeDirectory", () => {
        it("should use first 8 characters of pubkey", () => {
            const homeDir = getAgentHomeDirectory("abcdefgh12345678");
            expect(homeDir).toContain("abcdefgh");
            expect(homeDir).not.toContain("12345678");
        });

        it("should return consistent paths for same pubkey", () => {
            const homeDir1 = getAgentHomeDirectory("test1234abcd");
            const homeDir2 = getAgentHomeDirectory("test1234abcd");
            expect(homeDir1).toBe(homeDir2);
        });
    });

    describe("getAgentHomeInjectedFiles", () => {
        const testPubkey = "injtest1234567890";

        beforeEach(() => {
            // Create test home directory
            const homeDir = getAgentHomeDirectory(testPubkey);
            mkdirSync(homeDir, { recursive: true });
        });

        afterEach(() => {
            // Cleanup test home directory
            const homeDir = getAgentHomeDirectory(testPubkey);
            try {
                rmSync(homeDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        });

        it("should return empty array when no +prefixed files exist", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            writeFileSync(join(homeDir, "regular-file.txt"), "content");

            const result = getAgentHomeInjectedFiles(testPubkey);
            expect(result).toEqual([]);
        });

        it("should return +prefixed files with content", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            writeFileSync(join(homeDir, "+NOTES.md"), "My notes");
            writeFileSync(join(homeDir, "+REMINDERS.txt"), "Remember this");

            const result = getAgentHomeInjectedFiles(testPubkey);
            expect(result.length).toBe(2);
            expect(result[0].filename).toBe("+NOTES.md");
            expect(result[0].content).toBe("My notes");
            expect(result[0].truncated).toBe(false);
            expect(result[1].filename).toBe("+REMINDERS.txt");
            expect(result[1].content).toBe("Remember this");
        });

        it("should truncate files over 1500 characters", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            const longContent = "x".repeat(2000);
            writeFileSync(join(homeDir, "+LONG.txt"), longContent);

            const result = getAgentHomeInjectedFiles(testPubkey);
            expect(result.length).toBe(1);
            expect(result[0].truncated).toBe(true);
            expect(result[0].content.length).toBe(1500);
        });

        it("should limit to 10 files maximum", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            for (let i = 0; i < 15; i++) {
                writeFileSync(join(homeDir, `+FILE-${String(i).padStart(2, "0")}.txt`), `Content ${i}`);
            }

            const result = getAgentHomeInjectedFiles(testPubkey);
            expect(result.length).toBe(10);
        });

        it("should skip directories starting with +", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            mkdirSync(join(homeDir, "+DIRECTORY"));
            writeFileSync(join(homeDir, "+FILE.txt"), "content");

            const result = getAgentHomeInjectedFiles(testPubkey);
            expect(result.length).toBe(1);
            expect(result[0].filename).toBe("+FILE.txt");
        });

        it("should sort files alphabetically", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            writeFileSync(join(homeDir, "+ZEBRA.txt"), "z");
            writeFileSync(join(homeDir, "+ALPHA.txt"), "a");
            writeFileSync(join(homeDir, "+BETA.txt"), "b");

            const result = getAgentHomeInjectedFiles(testPubkey);
            expect(result[0].filename).toBe("+ALPHA.txt");
            expect(result[1].filename).toBe("+BETA.txt");
            expect(result[2].filename).toBe("+ZEBRA.txt");
        });

        it("should skip symlinks starting with + (security: prevents symlink escape attacks)", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);

            // Create a regular file
            writeFileSync(join(homeDir, "+REGULAR.txt"), "regular content");

            // Create a symlink to a file outside home (simulated escape attempt)
            const outsideFile = "/tmp/tenex-test-outside-file.txt";
            writeFileSync(outsideFile, "outside content - should not be read");
            try {
                symlinkSync(outsideFile, join(homeDir, "+SYMLINK.txt"));
            } catch {
                // Symlink creation might fail on some systems, skip test
                rmSync(outsideFile, { force: true });
                return;
            }

            const result = getAgentHomeInjectedFiles(testPubkey);

            // Should only return the regular file, not the symlink
            expect(result.length).toBe(1);
            expect(result[0].filename).toBe("+REGULAR.txt");
            expect(result[0].content).toBe("regular content");

            // Cleanup
            rmSync(outsideFile, { force: true });
        });

        it("should skip symlinks pointing within home (security: consistent symlink rejection)", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);

            // Create a regular file
            const targetFile = join(homeDir, "target.txt");
            writeFileSync(targetFile, "target content");

            // Create a +prefixed symlink pointing to a file within home
            // Even internal symlinks are rejected for consistent security
            try {
                symlinkSync(targetFile, join(homeDir, "+INTERNAL_LINK.txt"));
            } catch {
                // Symlink creation might fail, skip test
                return;
            }

            writeFileSync(join(homeDir, "+REGULAR.txt"), "regular");

            const result = getAgentHomeInjectedFiles(testPubkey);

            // Should only return the regular file, not the internal symlink
            expect(result.length).toBe(1);
            expect(result[0].filename).toBe("+REGULAR.txt");
        });

        it("should handle large files without memory spikes (bounded read)", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);

            // Create a file larger than MAX_INJECTED_FILE_LENGTH (1500)
            // but we're reading bounded, so memory usage should be limited
            const largeContent = "x".repeat(5000);
            writeFileSync(join(homeDir, "+LARGE.txt"), largeContent);

            const result = getAgentHomeInjectedFiles(testPubkey);

            expect(result.length).toBe(1);
            expect(result[0].truncated).toBe(true);
            // Content should be truncated to MAX_INJECTED_FILE_LENGTH
            expect(result[0].content.length).toBe(1500);
        });
    });

    describe("resolveHomeScopedPath", () => {
        const testPubkey = "scopetest12345678";

        beforeEach(() => {
            // Ensure home directory exists
            const homeDir = getAgentHomeDirectory(testPubkey);
            mkdirSync(homeDir, { recursive: true });
        });

        afterEach(() => {
            // Cleanup
            const homeDir = getAgentHomeDirectory(testPubkey);
            try {
                rmSync(homeDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        });

        it("should resolve relative paths against home directory", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            const result = resolveHomeScopedPath("notes.txt", testPubkey);
            expect(result).toBe(join(homeDir, "notes.txt"));
        });

        it("should accept absolute paths within home", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            const absolutePath = join(homeDir, "subdir", "file.txt");
            const result = resolveHomeScopedPath(absolutePath, testPubkey);
            expect(result).toBe(absolutePath);
        });

        it("should throw HomeScopeViolationError for paths escaping home with ..", () => {
            expect(() => {
                resolveHomeScopedPath("../other-agent/file.txt", testPubkey);
            }).toThrow(HomeScopeViolationError);
        });

        it("should throw HomeScopeViolationError for absolute paths outside home", () => {
            expect(() => {
                resolveHomeScopedPath("/etc/passwd", testPubkey);
            }).toThrow(HomeScopeViolationError);
        });

        it("should handle nested relative paths correctly", () => {
            const homeDir = getAgentHomeDirectory(testPubkey);
            const result = resolveHomeScopedPath("subdir/nested/file.txt", testPubkey);
            expect(result).toBe(join(homeDir, "subdir/nested/file.txt"));
        });

        it("should prevent complex traversal attacks", () => {
            expect(() => {
                resolveHomeScopedPath("subdir/../../other/file.txt", testPubkey);
            }).toThrow(HomeScopeViolationError);
        });

        it("should include helpful error message on violation", () => {
            try {
                resolveHomeScopedPath("/etc/passwd", testPubkey);
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(HomeScopeViolationError);
                expect((error as Error).message).toContain("outside your home directory");
            }
        });
    });
});
