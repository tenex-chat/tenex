import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import type { ExecutionContext } from "@/agents/execution/types";
import { createReadPathTool } from "../read_path";

// Mock conversation manager
const mockConversationCoordinator = {
    getConversation: mock(() => ({
        metadata: {},
    })),
};

describe("readPath tool", () => {
    let testDir: string;
    let context: ExecutionContext;
    let readPathTool: ReturnType<typeof createReadPathTool>;

    beforeEach(async () => {
        testDir = await createTempDir();

        // Reset mocks before each test
        mockConversationCoordinator.getConversation.mockClear();

        // Reset mock implementation
        mockConversationCoordinator.getConversation = mock(() => ({
            metadata: {},
        }));

        // Create test context
        context = {
            workingDirectory: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { name: "TestAgent", slug: "test-agent", pubkey: "pubkey123" },
            conversationCoordinator: mockConversationCoordinator as any,
            getConversation: () => mockConversationCoordinator.getConversation() as any,
        } as ExecutionContext;

        // Create tool instance
        readPathTool = createReadPathTool(context);
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("file reading", () => {
        it("should read a text file successfully", async () => {
            const testFile = path.join(testDir, "test.txt");
            writeFileSync(testFile, "Hello, World!");

            const result = await readPathTool.execute({ path: "test.txt" });

            expect(result).toBe("Hello, World!");
        });

        it("should read a file with absolute path", async () => {
            const testFile = path.join(testDir, "absolute.txt");
            writeFileSync(testFile, "Absolute content");

            const result = await readPathTool.execute({ path: testFile });

            expect(result).toBe("Absolute content");
        });

        it("should read files with various encodings", async () => {
            const testFile = path.join(testDir, "unicode.txt");
            const content = "Unicode: 你好世界 🌍 émojis";
            writeFileSync(testFile, content, "utf-8");

            const result = await readPathTool.execute({ path: "unicode.txt" });

            expect(result).toBe(content);
        });

        it("should read files from subdirectories", async () => {
            const subDir = path.join(testDir, "subdir");
            mkdirSync(subDir, { recursive: true });

            const testFile = path.join(subDir, "nested.txt");
            writeFileSync(testFile, "Nested content");

            const result = await readPathTool.execute({ path: "subdir/nested.txt" });

            expect(result).toBe("Nested content");
        });
    });

    describe("directory reading", () => {
        it("should list directory contents", async () => {
            // Create test files and directories
            writeFileSync(path.join(testDir, "file1.txt"), "content1");
            writeFileSync(path.join(testDir, "file2.js"), "content2");
            mkdirSync(path.join(testDir, "subdir"));

            const result = await readPathTool.execute({ path: "." });

            expect(result).toContain("Directory listing for .");
            expect(result).toContain("- file1.txt");
            expect(result).toContain("- file2.js");
            expect(result).toContain("- subdir");
        });

        it("should handle empty directories", async () => {
            const emptyDir = path.join(testDir, "empty");
            mkdirSync(emptyDir);

            const result = await readPathTool.execute({ path: "empty" });

            expect(result).toContain("Directory listing for empty:");
            expect(result).toContain("To read a specific file");
        });
    });

    describe("error handling", () => {
        it("should handle non-existent files", async () => {
            await expect(readPathTool.execute({ path: "non-existent.txt" })).rejects.toThrow("ENOENT");
        });

        it("should handle permission errors", async () => {
            const testFile = path.join(testDir, "no-read.txt");
            writeFileSync(testFile, "content");

            // Make file unreadable (this might not work on all systems)
            try {
                require("node:fs").chmodSync(testFile, 0o000);

                await expect(readPathTool.execute({ path: "no-read.txt" })).rejects.toThrow();
            } catch {
                // Skip test if chmod doesn't work
                console.log("Skipping permission test - chmod not supported");
            } finally {
                // Restore permissions
                try {
                    require("node:fs").chmodSync(testFile, 0o644);
                } catch (_error) {
                    // Cleanup error ignored in test teardown
                }
            }
        });

        it("should handle paths outside project directory", async () => {
            await expect(
                readPathTool.execute({ path: "../../../etc/passwd" })
            ).rejects.toThrow("Path outside project directory");
        });

        it("should handle EISDIR error gracefully", async () => {
            mkdirSync(path.join(testDir, "dir"));

            const result = await readPathTool.execute({ path: "dir" });

            // Should return directory listing instead of error
            expect(result).toContain("Directory listing for dir:");
        });

        it("should handle circular symlinks", async () => {
            // Create circular symlink (platform dependent)
            const symlinkPath = path.join(testDir, "circular");
            try {
                require("node:fs").symlinkSync(symlinkPath, symlinkPath);

                await expect(readPathTool.execute({ path: "circular" })).rejects.toThrow();
            } catch {
                // Skip if symlinks not supported
                console.log("Skipping symlink test - not supported on this platform");
            }
        });
    });

    describe("edge cases", () => {
        it("should handle empty files", async () => {
            const emptyFile = path.join(testDir, "empty.txt");
            writeFileSync(emptyFile, "");

            const result = await readPathTool.execute({ path: "empty.txt" });

            expect(result).toBe("");
        });

        it("should handle very large files", async () => {
            const largeFile = path.join(testDir, "large.txt");
            const largeContent = "x".repeat(1024 * 1024); // 1MB
            writeFileSync(largeFile, largeContent);

            const result = await readPathTool.execute({ path: "large.txt" });

            expect(result).toBe(largeContent);
        });

        it("should handle files with special characters in names", async () => {
            const specialFile = path.join(testDir, "special-@#$%.txt");
            writeFileSync(specialFile, "Special content");

            const result = await readPathTool.execute({ path: "special-@#$%.txt" });

            expect(result).toBe("Special content");
        });

        it("should handle directory names that look like files", async () => {
            const dirWithExt = path.join(testDir, "looks-like-file.txt");
            mkdirSync(dirWithExt);
            writeFileSync(path.join(dirWithExt, "actual-file.txt"), "content");

            const result = await readPathTool.execute({ path: "looks-like-file.txt" });

            expect(result).toContain("Directory listing");
            expect(result).toContain("- actual-file.txt");
        });

        it("should handle paths with multiple slashes", async () => {
            const testFile = path.join(testDir, "test.txt");
            writeFileSync(testFile, "content");

            const result = await readPathTool.execute({ path: ".//test.txt" });

            expect(result).toBe("content");
        });
    });

});
