import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import type { ExecutionContext } from "@/agents/execution/types";
import { createWriteFileTool } from "../write_file";

describe("write_file tool", () => {
    let testDir: string;
    let context: ExecutionContext;
    let writeFileTool: ReturnType<typeof createWriteFileTool>;

    beforeEach(async () => {
        testDir = await createTempDir();

        // Create test context
        context = {
            workingDirectory: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { name: "TestAgent", slug: "test-agent", pubkey: "pubkey123" },
        } as ExecutionContext;

        // Create tool instance
        writeFileTool = createWriteFileTool(context);
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("file writing", () => {
        it("should write a text file successfully", async () => {
            const result = await writeFileTool.execute({
                path: "test.txt",
                content: "Hello, World!",
            });

            expect(result).toContain("Successfully wrote");
            expect(result).toContain("test.txt");

            // Verify file was actually written
            const written = readFileSync(path.join(testDir, "test.txt"), "utf-8");
            expect(written).toBe("Hello, World!");
        });

        it("should write a file with absolute path", async () => {
            const absolutePath = path.join(testDir, "absolute.txt");

            const result = await writeFileTool.execute({
                path: absolutePath,
                content: "Absolute content",
            });

            expect(result).toContain("Successfully wrote");

            const written = readFileSync(absolutePath, "utf-8");
            expect(written).toBe("Absolute content");
        });

        it("should handle unicode content", async () => {
            const content = "Unicode: 你好世界 🌍 émojis";

            await writeFileTool.execute({
                path: "unicode.txt",
                content,
            });

            const written = readFileSync(path.join(testDir, "unicode.txt"), "utf-8");
            expect(written).toBe(content);
        });

        it("should create subdirectories if they don't exist", async () => {
            await writeFileTool.execute({
                path: "subdir/nested/file.txt",
                content: "Nested content",
            });

            const written = readFileSync(
                path.join(testDir, "subdir/nested/file.txt"),
                "utf-8"
            );
            expect(written).toBe("Nested content");
        });

        it("should overwrite existing files", async () => {
            const filePath = path.join(testDir, "existing.txt");

            // Write initial content
            await writeFileTool.execute({
                path: "existing.txt",
                content: "Initial content",
            });

            // Overwrite
            await writeFileTool.execute({
                path: "existing.txt",
                content: "Updated content",
            });

            const written = readFileSync(filePath, "utf-8");
            expect(written).toBe("Updated content");
        });
    });

    describe("error handling", () => {
        it("should reject paths outside project directory", async () => {
            await expect(
                writeFileTool.execute({
                    path: "../../../etc/passwd",
                    content: "malicious",
                })
            ).rejects.toThrow("Path outside project directory");
        });

        it("should handle empty content", async () => {
            await writeFileTool.execute({
                path: "empty.txt",
                content: "",
            });

            const written = readFileSync(path.join(testDir, "empty.txt"), "utf-8");
            expect(written).toBe("");
        });
    });

    describe("edge cases", () => {
        it("should handle files with special characters in names", async () => {
            await writeFileTool.execute({
                path: "special-@#$%.txt",
                content: "Special content",
            });

            const written = readFileSync(path.join(testDir, "special-@#$%.txt"), "utf-8");
            expect(written).toBe("Special content");
        });

        it("should handle very large files", async () => {
            const largeContent = "x".repeat(1024 * 1024); // 1MB

            await writeFileTool.execute({
                path: "large.txt",
                content: largeContent,
            });

            const written = readFileSync(path.join(testDir, "large.txt"), "utf-8");
            expect(written).toBe(largeContent);
        });

        it("should handle paths with multiple slashes", async () => {
            await writeFileTool.execute({
                path: ".//test.txt",
                content: "content",
            });

            const written = readFileSync(path.join(testDir, "test.txt"), "utf-8");
            expect(written).toBe("content");
        });
    });
});
