import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import type { ExecutionEnvironment } from "@/tools/types";
import { createFsGlobTool } from "../fs_glob";

describe("fs_glob tool", () => {
    let testDir: string;
    let context: ExecutionEnvironment;
    let globTool: ReturnType<typeof createFsGlobTool>;

    beforeEach(async () => {
        testDir = await createTempDir();

        context = {
            workingDirectory: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { name: "TestAgent", slug: "test-agent", pubkey: "pubkey123" },
        } as ExecutionEnvironment;

        globTool = createFsGlobTool(context);
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("absolute path requirement", () => {
        it("should reject relative paths", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "content");

            const result = await globTool.execute({
                pattern: "*.txt",
                path: "subdir",
            });

            expect(result).toContain("Path must be absolute");
        });

        it("should accept absolute paths", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "content");

            const result = await globTool.execute({
                pattern: "*.txt",
                path: testDir,
            });

            expect(result).toContain("test.txt");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block globbing outside working directory by default", async () => {
            const outsideDir = await createTempDir();
            writeFileSync(path.join(outsideDir, "outside.txt"), "content");

            try {
                const result = await globTool.execute({
                    pattern: "*.txt",
                    path: outsideDir,
                });

                expect(result).toContain("outside your working directory");
                expect(result).toContain("allowOutsideWorkingDirectory: true");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow globbing outside when flag is set", async () => {
            const outsideDir = await createTempDir();
            writeFileSync(path.join(outsideDir, "outside.txt"), "content");

            try {
                const result = await globTool.execute({
                    pattern: "*.txt",
                    path: outsideDir,
                    allowOutsideWorkingDirectory: true,
                });

                expect(result).toContain("outside.txt");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow globbing within working directory without flag", async () => {
            writeFileSync(path.join(testDir, "inside.txt"), "content");

            const result = await globTool.execute({
                pattern: "*.txt",
                path: testDir,
            });

            expect(result).toContain("inside.txt");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = testDir + "-backup";
            mkdirSync(similarDir, { recursive: true });
            writeFileSync(path.join(similarDir, "sneaky.txt"), "content");

            try {
                const result = await globTool.execute({
                    pattern: "*.txt",
                    path: similarDir,
                });

                expect(result).toContain("outside your working directory");
            } finally {
                await cleanupTempDir(similarDir);
            }
        });
    });

    describe("basic functionality", () => {
        it("should find files matching pattern", async () => {
            writeFileSync(path.join(testDir, "file1.txt"), "content");
            writeFileSync(path.join(testDir, "file2.txt"), "content");
            writeFileSync(path.join(testDir, "file3.js"), "content");

            const result = await globTool.execute({
                pattern: "*.txt",
                path: testDir,
            });

            expect(result).toContain("file1.txt");
            expect(result).toContain("file2.txt");
            expect(result).not.toContain("file3.js");
        });

        it("should return no files message when nothing found", async () => {
            const result = await globTool.execute({
                pattern: "*.nonexistent",
                path: testDir,
            });

            expect(result).toContain("No files found");
        });

        it("should support recursive patterns", async () => {
            const subDir = path.join(testDir, "sub");
            mkdirSync(subDir, { recursive: true });
            writeFileSync(path.join(subDir, "nested.txt"), "content");

            const result = await globTool.execute({
                pattern: "**/*.txt",
                path: testDir,
            });

            expect(result).toContain("nested.txt");
        });
    });
});
