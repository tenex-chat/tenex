import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import type { ExecutionEnvironment } from "@/tools/types";
import { createFsGrepTool } from "../fs_grep";

describe("fs_grep tool", () => {
    let testDir: string;
    let context: ExecutionEnvironment;
    let grepTool: ReturnType<typeof createFsGrepTool>;

    beforeEach(async () => {
        testDir = await createTempDir();

        context = {
            workingDirectory: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { name: "TestAgent", slug: "test-agent", pubkey: "pubkey123" },
        } as ExecutionEnvironment;

        grepTool = createFsGrepTool(context);
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("absolute path requirement", () => {
        it("should reject relative paths", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "hello world");

            const result = await grepTool.execute({
                pattern: "hello",
                path: "test.txt",
            });

            expect(result).toContain("Path must be absolute");
        });

        it("should accept absolute paths", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "hello world");

            const result = await grepTool.execute({
                pattern: "hello",
                path: testDir,
            });

            expect(result).toContain("test.txt");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block searching outside working directory by default", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "secret content");

            try {
                const result = await grepTool.execute({
                    pattern: "secret",
                    path: outsideDir,
                });

                expect(result).toContain("outside your working directory");
                expect(result).toContain("allowOutsideWorkingDirectory: true");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow searching outside when flag is set", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "findme content");

            try {
                const result = await grepTool.execute({
                    pattern: "findme",
                    path: outsideDir,
                    allowOutsideWorkingDirectory: true,
                });

                expect(result).toContain("outside.txt");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow searching within working directory without flag", async () => {
            writeFileSync(path.join(testDir, "inside.txt"), "findme content");

            const result = await grepTool.execute({
                pattern: "findme",
                path: testDir,
            });

            expect(result).toContain("inside.txt");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = testDir + "-backup";
            mkdirSync(similarDir, { recursive: true });
            writeFileSync(path.join(similarDir, "sneaky.txt"), "findme content");

            try {
                const result = await grepTool.execute({
                    pattern: "findme",
                    path: similarDir,
                });

                expect(result).toContain("outside your working directory");
            } finally {
                await cleanupTempDir(similarDir);
            }
        });
    });

    describe("basic functionality", () => {
        it("should find matches in files", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "hello world");

            const result = await grepTool.execute({
                pattern: "hello",
                path: testDir,
            });

            expect(result).toContain("test.txt");
        });

        it("should return no matches message when nothing found", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "hello world");

            const result = await grepTool.execute({
                pattern: "notfound",
                path: testDir,
            });

            expect(result).toContain("No matches found");
        });

        it("should support different output modes", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "hello world\nhello again");

            const contentResult = await grepTool.execute({
                pattern: "hello",
                path: testDir,
                output_mode: "content",
            });

            expect(contentResult).toContain("hello");
        });
    });
});
