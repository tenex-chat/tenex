import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import type { ExecutionEnvironment } from "@/tools/types";
import { createFsWriteTool } from "../fs_write";

describe("fs_write tool", () => {
    let testDir: string;
    let context: ExecutionEnvironment;
    let writeTool: ReturnType<typeof createFsWriteTool>;

    beforeEach(async () => {
        testDir = await createTempDir();

        context = {
            workingDirectory: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { name: "TestAgent", slug: "test-agent", pubkey: "pubkey123" },
        } as ExecutionEnvironment;

        writeTool = createFsWriteTool(context);
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("absolute path requirement", () => {
        it("should reject relative paths", async () => {
            await expect(
                writeTool.execute({ path: "relative.txt", content: "test" })
            ).rejects.toThrow("Path must be absolute");
        });

        it("should accept absolute paths", async () => {
            const filePath = path.join(testDir, "test.txt");

            const result = await writeTool.execute({ path: filePath, content: "Hello" });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("Hello");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block writing outside working directory by default", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");

            try {
                const result = await writeTool.execute({
                    path: outsideFile,
                    content: "should not write",
                });

                expect(result).toContain("outside your working directory");
                expect(result).toContain("allowOutsideWorkingDirectory: true");
                // File should NOT exist
                expect(() => readFileSync(outsideFile)).toThrow();
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow writing outside when flag is set", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");

            try {
                const result = await writeTool.execute({
                    path: outsideFile,
                    content: "allowed content",
                    allowOutsideWorkingDirectory: true,
                });

                expect(result).toContain("Successfully wrote");
                expect(readFileSync(outsideFile, "utf-8")).toBe("allowed content");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow writing files within working directory without flag", async () => {
            const filePath = path.join(testDir, "inside.txt");

            const result = await writeTool.execute({
                path: filePath,
                content: "inside content",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("inside content");
        });

        it("should allow writing to subdirectories of working directory", async () => {
            const subDir = path.join(testDir, "sub", "nested");
            const filePath = path.join(subDir, "deep.txt");

            const result = await writeTool.execute({
                path: filePath,
                content: "deep content",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("deep content");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = testDir + "-backup";
            mkdirSync(similarDir, { recursive: true });
            const outsideFile = path.join(similarDir, "sneaky.txt");

            try {
                const result = await writeTool.execute({
                    path: outsideFile,
                    content: "sneaky content",
                });

                expect(result).toContain("outside your working directory");
            } finally {
                await cleanupTempDir(similarDir);
            }
        });
    });

    describe("basic functionality", () => {
        it("should create parent directories automatically", async () => {
            const filePath = path.join(testDir, "new", "nested", "dir", "file.txt");

            const result = await writeTool.execute({
                path: filePath,
                content: "nested content",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("nested content");
        });

        it("should overwrite existing files", async () => {
            const filePath = path.join(testDir, "existing.txt");
            writeFileSync(filePath, "old content");

            const result = await writeTool.execute({
                path: filePath,
                content: "new content",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("new content");
        });

        it("should report bytes written", async () => {
            const filePath = path.join(testDir, "test.txt");
            const content = "Hello, World!"; // 13 bytes

            const result = await writeTool.execute({
                path: filePath,
                content,
            });

            expect(result).toContain("13 bytes");
        });

        it("should handle unicode content", async () => {
            const filePath = path.join(testDir, "unicode.txt");
            const content = "你好世界 🌍";

            const result = await writeTool.execute({
                path: filePath,
                content,
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe(content);
        });

        it("should handle empty content", async () => {
            const filePath = path.join(testDir, "empty.txt");

            const result = await writeTool.execute({
                path: filePath,
                content: "",
            });

            expect(result).toContain("Successfully wrote 0 bytes");
            expect(readFileSync(filePath, "utf-8")).toBe("");
        });
    });
});
