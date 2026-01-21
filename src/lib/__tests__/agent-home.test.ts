import { describe, expect, it, mock } from "bun:test";
import { getAgentHomeDirectory, isPathWithinDirectory, isWithinAgentHome, normalizePath } from "../agent-home";

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
});
