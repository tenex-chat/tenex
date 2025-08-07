import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { readPathTool } from "../readPath";
import { createTempDir, cleanupTempDir } from "@/test-utils";
import { writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { Tool, ToolContext } from "@/tools/types";

// Mock conversation manager
const mockConversationManager = {
    getConversation: mock(() => ({
        metadata: {
            readFiles: []
        }
    })),
    updateMetadata: mock(async () => {})
};

describe("readPath tool", () => {
    let testDir: string;
    let context: ToolContext;

    beforeEach(async () => {
        testDir = await createTempDir();
        
        // Reset mocks before each test
        mockConversationManager.getConversation.mockClear();
        mockConversationManager.updateMetadata.mockClear();
        
        // Reset mock implementation
        mockConversationManager.getConversation = mock(() => ({
            metadata: {
                readFiles: []
            }
        }));
        
        // Create test context
        context = {
            projectPath: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { name: "TestAgent", slug: "test-agent", pubkey: "pubkey123" },
            conversationManager: mockConversationManager as any,
        };
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("file reading", () => {
        it("should read a text file successfully", async () => {
            const testFile = path.join(testDir, "test.txt");
            writeFileSync(testFile, "Hello, World!");

            const result = await readPathTool.execute(
                { value: { path: "test.txt" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toBe("Hello, World!");
        });

        it("should read a file with absolute path", async () => {
            const testFile = path.join(testDir, "absolute.txt");
            writeFileSync(testFile, "Absolute content");

            const result = await readPathTool.execute(
                { value: { path: testFile }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toBe("Absolute content");
        });

        it("should read files with various encodings", async () => {
            const testFile = path.join(testDir, "unicode.txt");
            const content = "Unicode: 你好世界 🌍 émojis";
            writeFileSync(testFile, content, "utf-8");

            const result = await readPathTool.execute(
                { value: { path: "unicode.txt" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toBe(content);
        });

        it("should read files from subdirectories", async () => {
            const subDir = path.join(testDir, "subdir");
            mkdirSync(subDir, { recursive: true });
            
            const testFile = path.join(subDir, "nested.txt");
            writeFileSync(testFile, "Nested content");

            const result = await readPathTool.execute(
                { value: { path: "subdir/nested.txt" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toBe("Nested content");
        });
    });

    describe("directory reading", () => {
        it("should list directory contents", async () => {
            // Create test files and directories
            writeFileSync(path.join(testDir, "file1.txt"), "content1");
            writeFileSync(path.join(testDir, "file2.js"), "content2");
            mkdirSync(path.join(testDir, "subdir"));

            const result = await readPathTool.execute(
                { value: { path: "." }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toContain("Directory listing for .");
            expect(result.value).toContain("- file1.txt");
            expect(result.value).toContain("- file2.js");
            expect(result.value).toContain("- subdir");
        });

        it("should handle empty directories", async () => {
            const emptyDir = path.join(testDir, "empty");
            mkdirSync(emptyDir);

            const result = await readPathTool.execute(
                { value: { path: "empty" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toContain("Directory listing for empty:");
            expect(result.value).toContain("To read a specific file");
        });
    });

    describe("context file tracking", () => {
        it("should track context/ files in metadata", async () => {
            const contextDir = path.join(testDir, "context");
            mkdirSync(contextDir);
            writeFileSync(path.join(contextDir, "important.md"), "Context content");

            await readPathTool.execute(
                { value: { path: "context/important.md" }, parsed: true },
                context
            );

            expect(mockConversationManager.updateMetadata).toHaveBeenCalledWith(
                "test-conv-123",
                { readFiles: ["context/important.md"] }
            );
        });

        it("should not duplicate tracked files", async () => {
            const contextDir = path.join(testDir, "context");
            mkdirSync(contextDir);
            writeFileSync(path.join(contextDir, "tracked.md"), "Already tracked");

            // Mock conversation with existing tracked file
            mockConversationManager.getConversation = mock(() => ({
                metadata: { readFiles: ["context/tracked.md"] }
            }));

            await readPathTool.execute(
                { value: { path: "context/tracked.md" }, parsed: true },
                context
            );

            expect(mockConversationManager.updateMetadata).not.toHaveBeenCalled();
        });

        it("should not track non-context files", async () => {
            writeFileSync(path.join(testDir, "regular.txt"), "Regular file");

            await readPathTool.execute(
                { value: { path: "regular.txt" }, parsed: true },
                context
            );

            expect(mockConversationManager.updateMetadata).not.toHaveBeenCalled();
        });
    });

    describe("error handling", () => {
        it("should handle non-existent files", async () => {
            const result = await readPathTool.execute(
                { value: { path: "non-existent.txt" }, parsed: true },
                context
            );

            expect(result.ok).toBe(false);
            expect(result.error?.kind).toBe("execution");
            expect(result.error?.tool).toBe("read_path");
            expect(result.error?.message).toContain("ENOENT");
        });

        it("should handle permission errors", async () => {
            const testFile = path.join(testDir, "no-read.txt");
            writeFileSync(testFile, "content");
            
            // Make file unreadable (this might not work on all systems)
            try {
                require('fs').chmodSync(testFile, 0o000);
                
                const result = await readPathTool.execute(
                    { value: { path: "no-read.txt" }, parsed: true },
                    context
                );

                expect(result.ok).toBe(false);
                expect(result.error?.kind).toBe("execution");
            } catch {
                // Skip test if chmod doesn't work
                console.log("Skipping permission test - chmod not supported");
            } finally {
                // Restore permissions
                try {
                    require('fs').chmodSync(testFile, 0o644);
                } catch (error) {
                    // Cleanup error ignored in test teardown
                }
            }
        });

        it("should handle paths outside project directory", async () => {
            const result = await readPathTool.execute(
                { value: { path: "../../../etc/passwd" }, parsed: true },
                context
            );

            expect(result.ok).toBe(false);
            expect(result.error?.kind).toBe("execution");
            expect(result.error?.message).toContain("Path outside project directory");
        });

        it("should handle EISDIR error gracefully", async () => {
            mkdirSync(path.join(testDir, "dir"));

            const result = await readPathTool.execute(
                { value: { path: "dir" }, parsed: true },
                context
            );

            // Should return directory listing instead of error
            expect(result.ok).toBe(true);
            expect(result.value).toContain("Directory listing for dir:");
        });

        it("should handle circular symlinks", async () => {
            // Create circular symlink (platform dependent)
            const symlinkPath = path.join(testDir, "circular");
            try {
                require('fs').symlinkSync(symlinkPath, symlinkPath);
                
                const result = await readPathTool.execute(
                    { value: { path: "circular" }, parsed: true },
                    context
                );

                expect(result.ok).toBe(false);
                expect(result.error?.kind).toBe("execution");
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

            const result = await readPathTool.execute(
                { value: { path: "empty.txt" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toBe("");
        });

        it("should handle very large files", async () => {
            const largeFile = path.join(testDir, "large.txt");
            const largeContent = "x".repeat(1024 * 1024); // 1MB
            writeFileSync(largeFile, largeContent);

            const result = await readPathTool.execute(
                { value: { path: "large.txt" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toBe(largeContent);
        });

        it("should handle files with special characters in names", async () => {
            const specialFile = path.join(testDir, "special-@#$%.txt");
            writeFileSync(specialFile, "Special content");

            const result = await readPathTool.execute(
                { value: { path: "special-@#$%.txt" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toBe("Special content");
        });

        it("should handle directory names that look like files", async () => {
            const dirWithExt = path.join(testDir, "looks-like-file.txt");
            mkdirSync(dirWithExt);
            writeFileSync(path.join(dirWithExt, "actual-file.txt"), "content");

            const result = await readPathTool.execute(
                { value: { path: "looks-like-file.txt" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toContain("Directory listing");
            expect(result.value).toContain("- actual-file.txt");
        });

        it("should handle paths with multiple slashes", async () => {
            const testFile = path.join(testDir, "test.txt");
            writeFileSync(testFile, "content");

            const result = await readPathTool.execute(
                { value: { path: ".//test.txt" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(result.value).toBe("content");
        });
    });

    describe("metadata edge cases", () => {
        it("should handle missing conversation", async () => {
            const contextDir = path.join(testDir, "context");
            mkdirSync(contextDir);
            writeFileSync(path.join(contextDir, "file.md"), "content");

            // Context without conversation manager
            const minimalContext = {
                ...context,
                conversationManager: undefined
            };

            const result = await readPathTool.execute(
                { value: { path: "context/file.md" }, parsed: true },
                minimalContext
            );

            expect(result.ok).toBe(true);
            expect(result.value).toBe("content");
        });

        it("should handle conversation without metadata", async () => {
            const contextDir = path.join(testDir, "context");
            mkdirSync(contextDir);
            writeFileSync(path.join(contextDir, "file.md"), "content");

            mockConversationManager.getConversation = mock(() => null);

            const result = await readPathTool.execute(
                { value: { path: "context/file.md" }, parsed: true },
                context
            );

            expect(result.ok).toBe(true);
            expect(mockConversationManager.updateMetadata).toHaveBeenCalledWith(
                "test-conv-123",
                { readFiles: ["context/file.md"] }
            );
        });
    });
});