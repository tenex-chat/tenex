import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import type { ExecutionEnvironment } from "@/tools/types";
import { createFsReadTool } from "../fs_read";

describe("fs_read tool", () => {
    let testDir: string;
    let context: ExecutionEnvironment;
    let readTool: ReturnType<typeof createFsReadTool>;

    beforeEach(async () => {
        testDir = await createTempDir();

        context = {
            workingDirectory: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { name: "TestAgent", slug: "test-agent", pubkey: "pubkey123" },
        } as ExecutionEnvironment;

        readTool = createFsReadTool(context);
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("absolute path requirement", () => {
        it("should reject relative paths", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "content");

            await expect(
                readTool.execute({ path: "test.txt" })
            ).rejects.toThrow("Path must be absolute");
        });

        it("should accept absolute paths", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello");

            const result = await readTool.execute({ path: filePath });

            expect(result).toContain("Hello");
        });
    });

    describe("line numbers", () => {
        it("should always include line numbers", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "line one\nline two\nline three");

            const result = await readTool.execute({ path: filePath });

            expect(result).toMatch(/^\s*1\t/m);
            expect(result).toMatch(/^\s*2\t/m);
            expect(result).toMatch(/^\s*3\t/m);
        });

        it("should use 6-char padded line numbers", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "content");

            const result = await readTool.execute({ path: filePath });

            // Line number should be padded to 6 characters
            expect(result).toMatch(/^\s{5}1\t/);
        });
    });

    describe("offset parameter (1-based)", () => {
        it("should start from specified line (1-based)", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5");

            const result = await readTool.execute({ path: filePath, offset: 3 });

            expect(result).not.toContain("line1");
            expect(result).not.toContain("line2");
            expect(result).toContain("line3");
            expect(result).toContain("line4");
            expect(result).toContain("line5");
        });

        it("should show correct line numbers when using offset", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "a\nb\nc\nd\ne");

            const result = await readTool.execute({ path: filePath, offset: 3 });

            // Should show line 3 as "3", not "1"
            expect(result).toMatch(/^\s*3\tc$/m);
        });

        it("should return error for offset beyond file length", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "one\ntwo");

            const result = await readTool.execute({ path: filePath, offset: 100 });

            expect(result).toContain("only 2 line(s)");
        });
    });

    describe("limit parameter", () => {
        it("should default to 2000 lines", async () => {
            const filePath = path.join(testDir, "large.txt");
            const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
            writeFileSync(filePath, lines);

            const result = await readTool.execute({ path: filePath });

            expect(result).toContain("line 1");
            expect(result).toContain("line 2000");
            expect(result).not.toContain("line 2001");
            expect(result).toContain("[Showing lines 1-2000 of 3000");
        });

        it("should respect custom limit", async () => {
            const filePath = path.join(testDir, "test.txt");
            const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
            writeFileSync(filePath, lines);

            const result = await readTool.execute({ path: filePath, limit: 5 });

            expect(result).toContain("line 1");
            expect(result).toContain("line 5");
            expect(result).not.toContain("line 6");
        });

        it("should show pagination hint when truncated", async () => {
            const filePath = path.join(testDir, "test.txt");
            const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
            writeFileSync(filePath, lines);

            const result = await readTool.execute({ path: filePath, limit: 10 });

            expect(result).toContain("[Showing lines 1-10 of 100");
            expect(result).toContain("Use offset=11 to continue");
        });

        it("should not show pagination hint when reading entire file", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "small file");

            const result = await readTool.execute({ path: filePath });

            expect(result).not.toContain("[Showing lines");
        });
    });

    describe("line truncation", () => {
        it("should truncate lines longer than 2000 characters", async () => {
            const filePath = path.join(testDir, "long-line.txt");
            const longLine = "x".repeat(3000);
            writeFileSync(filePath, longLine);

            const result = await readTool.execute({ path: filePath });

            // Should have exactly 2000 x's plus "..."
            expect(result).toContain("x".repeat(2000) + "...");
            expect(result).not.toContain("x".repeat(2001));
        });

        it("should not truncate lines under 2000 characters", async () => {
            const filePath = path.join(testDir, "normal-line.txt");
            const normalLine = "x".repeat(1999);
            writeFileSync(filePath, normalLine);

            const result = await readTool.execute({ path: filePath });

            expect(result).toContain(normalLine);
            expect(result).not.toContain("...");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block reading outside working directory by default", async () => {
            // Create a file outside the working directory
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "secret content");

            try {
                const result = await readTool.execute({ path: outsideFile });

                expect(result).toContain("outside your working directory");
                expect(result).toContain("allowOutsideWorkingDirectory: true");
                expect(result).not.toContain("secret content");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow reading outside when flag is set", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "allowed content");

            try {
                const result = await readTool.execute({
                    path: outsideFile,
                    allowOutsideWorkingDirectory: true,
                });

                expect(result).toContain("allowed content");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow reading files within working directory without flag", async () => {
            const filePath = path.join(testDir, "inside.txt");
            writeFileSync(filePath, "inside content");

            const result = await readTool.execute({ path: filePath });

            expect(result).toContain("inside content");
        });

        it("should allow reading files in subdirectories of working directory", async () => {
            const subDir = path.join(testDir, "sub", "nested");
            mkdirSync(subDir, { recursive: true });
            const filePath = path.join(subDir, "deep.txt");
            writeFileSync(filePath, "deep content");

            const result = await readTool.execute({ path: filePath });

            expect(result).toContain("deep content");
        });

        it("should block paths that look similar but are outside", async () => {
            // e.g., working dir is /tmp/project, trying to read /tmp/project-backup/file
            const similarDir = testDir + "-backup";
            mkdirSync(similarDir, { recursive: true });
            const outsideFile = path.join(similarDir, "sneaky.txt");
            writeFileSync(outsideFile, "sneaky content");

            try {
                const result = await readTool.execute({ path: outsideFile });

                expect(result).toContain("outside your working directory");
            } finally {
                await cleanupTempDir(similarDir);
            }
        });
    });

    describe("directory listing", () => {
        it("should list directory contents", async () => {
            const subDir = path.join(testDir, "mydir");
            mkdirSync(subDir);
            writeFileSync(path.join(subDir, "file1.txt"), "content");
            writeFileSync(path.join(subDir, "file2.txt"), "content");

            const result = await readTool.execute({ path: subDir });

            expect(result).toContain("Directory listing for");
            expect(result).toContain("file1.txt");
            expect(result).toContain("file2.txt");
        });
    });

    describe("error handling", () => {
        it("should report non-existent files", async () => {
            const nonExistent = path.join(testDir, "does-not-exist.txt");

            await expect(
                readTool.execute({ path: nonExistent })
            ).rejects.toThrow("Failed to read");
        });
    });
});
