import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createFsTools, type FsToolSet } from "ai-sdk-fs-tools";
import { cleanupTempDir, createTempDir } from "@/test-utils";

const TEST_HOME_BASE = "/tmp/tenex/home";
const getTestAgentHomeDir = (pubkey: string) => `${TEST_HOME_BASE}/${pubkey.slice(0, 8)}`;

function createTestFsTools(workingDirectory: string, agentPubkey: string): FsToolSet {
    return createFsTools({
        workingDirectory,
        allowedRoots: [getTestAgentHomeDir(agentPubkey)],
        agentsMd: false,
        formatOutsideRootsError: (p, wd) =>
            `Path "${p}" is outside your working directory "${wd}". If this was intentional, retry with allowOutsideWorkingDirectory: true`,
    });
}

function unwrapResult(result: string | { type: string; text: string }): string {
    return typeof result === "string" ? result : result.text;
}

describe("fs_grep tool", () => {
    let testDir: string;
    const agentPubkey = "pubkey123";
    let tools: FsToolSet;

    beforeEach(async () => {
        testDir = await createTempDir();
        tools = createTestFsTools(testDir, agentPubkey);
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("absolute path requirement", () => {
        it("should reject relative paths", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "hello world");

            const result = await tools.fs_grep.execute({
                pattern: "hello",
                path: "test.txt",
                description: "test grep",
            });

            expect(unwrapResult(result)).toContain("Path must be absolute");
        });

        it("should accept absolute paths", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "hello world");

            const result = await tools.fs_grep.execute({
                pattern: "hello",
                path: testDir,
                description: "test grep",
            });

            expect(unwrapResult(result)).toContain("test.txt");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block searching outside working directory by default", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "secret content");

            try {
                const result = await tools.fs_grep.execute({
                    pattern: "secret",
                    path: outsideDir,
                    description: "test grep",
                });

                const text = unwrapResult(result);
                expect(text).toContain("outside your working directory");
                expect(text).toContain("allowOutsideWorkingDirectory: true");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow searching outside when flag is set", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "findme content");

            try {
                const result = await tools.fs_grep.execute({
                    pattern: "findme",
                    path: outsideDir,
                    allowOutsideWorkingDirectory: true,
                    description: "test grep",
                });

                expect(unwrapResult(result)).toContain("outside.txt");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow searching within working directory without flag", async () => {
            writeFileSync(path.join(testDir, "inside.txt"), "findme content");

            const result = await tools.fs_grep.execute({
                pattern: "findme",
                path: testDir,
                description: "test grep",
            });

            expect(unwrapResult(result)).toContain("inside.txt");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = testDir + "-backup";
            mkdirSync(similarDir, { recursive: true });
            writeFileSync(path.join(similarDir, "sneaky.txt"), "findme content");

            try {
                const result = await tools.fs_grep.execute({
                    pattern: "findme",
                    path: similarDir,
                    description: "test grep",
                });

                expect(unwrapResult(result)).toContain("outside your working directory");
            } finally {
                await cleanupTempDir(similarDir);
            }
        });

        it("should allow searching inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            const agentHomeDir = getTestAgentHomeDir(agentPubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            writeFileSync(path.join(agentHomeDir, "notes.txt"), "my secret notes");

            try {
                const result = await tools.fs_grep.execute({
                    pattern: "secret",
                    path: agentHomeDir,
                    description: "test grep",
                });

                const text = unwrapResult(result);
                expect(text).toContain("notes.txt");
                expect(text).not.toContain("outside your working directory");
            } finally {
                await cleanupTempDir(agentHomeDir);
            }
        });
    });

    describe("basic functionality", () => {
        it("should find matches in files", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "hello world");

            const result = await tools.fs_grep.execute({
                pattern: "hello",
                path: testDir,
                description: "test grep",
            });

            expect(unwrapResult(result)).toContain("test.txt");
        });

        it("should return no matches message when nothing found", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "hello world");

            const result = await tools.fs_grep.execute({
                pattern: "notfound",
                path: testDir,
                description: "test grep",
            });

            expect(unwrapResult(result)).toContain("No matches found");
        });

        it("should support different output modes", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "hello world\nhello again");

            const contentResult = await tools.fs_grep.execute({
                pattern: "hello",
                path: testDir,
                output_mode: "content",
                description: "test grep",
            });

            expect(unwrapResult(contentResult)).toContain("hello");
        });
    });

    describe("auto-fallback for large content", () => {
        it("should return normal content output when under 50KB threshold", async () => {
            const content = "test line with pattern\n".repeat(100);
            writeFileSync(path.join(testDir, "small.txt"), content);

            const result = await tools.fs_grep.execute({
                pattern: "pattern",
                path: testDir,
                output_mode: "content",
                head_limit: 0,
                description: "test grep",
            });

            const text = unwrapResult(result);
            expect(text).toContain("test line with pattern");
            expect(text).not.toContain("size limit");
        });

        it("should fallback to file list when single large file exceeds 50KB", async () => {
            const logLine = "2024-01-01 12:00:00 [INFO] pattern match here\n";
            const largeContent = logLine.repeat(2000);
            writeFileSync(path.join(testDir, "large.log"), largeContent);

            const result = await tools.fs_grep.execute({
                pattern: "pattern",
                path: testDir,
                output_mode: "content",
                head_limit: 0,
                description: "test grep",
            });

            const text = unwrapResult(result);
            expect(text).toContain("size limit");
            expect(text).toContain("matching files instead");
            expect(text).toContain("large.log");
            expect(text).not.toContain("INFO");
        });

        it("should fallback to file list when many small files exceed 50KB total", async () => {
            const subDir = path.join(testDir, "many-files");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 900; i++) {
                const fileName = `file-${i.toString().padStart(4, "0")}.txt`;
                writeFileSync(path.join(subDir, fileName), `test pattern match in file ${i}\n`);
            }

            const result = await tools.fs_grep.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                head_limit: 0,
                description: "test grep",
            });

            const text = unwrapResult(result);
            expect(text).toContain("size limit");
            expect(text).toContain("matching files instead");
            expect(text).toContain("file-");
            expect(text).not.toContain("test pattern match");
        });

        it("should truncate file list when even that exceeds 50KB", async () => {
            const subDir = path.join(testDir, "absurd-files");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 1500; i++) {
                const fileName = `very-long-filename-to-increase-path-length-${i.toString().padStart(5, "0")}.txt`;
                writeFileSync(path.join(subDir, fileName), `pattern\n`);
            }

            const result = await tools.fs_grep.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                head_limit: 0,
                description: "test grep",
            });

            const text = unwrapResult(result);
            expect(text).toContain("size limit");
            expect(text).toContain("matching files instead");
        });

        it("should not trigger fallback when pagination keeps output under 50KB", async () => {
            const subDir = path.join(testDir, "paginated-files");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 500; i++) {
                const fileName = `file-${i.toString().padStart(4, "0")}.txt`;
                writeFileSync(path.join(subDir, fileName), `test pattern match in file ${i}\n`);
            }

            const result = await tools.fs_grep.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                head_limit: 100,
                description: "test grep",
            });

            const text = unwrapResult(result);
            expect(text).not.toContain("size limit");
            expect(text).toContain("test pattern match");
            expect(text).toContain("[Truncated: showing 100 of");
        });

        it("should respect offset in fallback file list", async () => {
            const subDir = path.join(testDir, "offset-test");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 900; i++) {
                const fileName = `file-${i.toString().padStart(4, "0")}.txt`;
                const longContent = "pattern match ".repeat(20) + i.toString();
                writeFileSync(path.join(subDir, fileName), `${longContent}\n`);
            }

            const result = await tools.fs_grep.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                offset: 50,
                head_limit: 200,
                description: "test grep",
            });

            const text = unwrapResult(result);
            expect(text).toContain("size limit");
            const lines = text.split("\n").filter((l) => l.includes("file-"));
            expect(lines.length).toBeGreaterThan(0);
            expect(lines.length).toBeLessThanOrEqual(200);
        });

        it("should enforce hard cap on fallback output", async () => {
            const subDir = path.join(testDir, "hard-cap-test");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 1500; i++) {
                const fileName = `very-long-filename-that-makes-path-bigger-${i.toString().padStart(5, "0")}.txt`;
                writeFileSync(path.join(subDir, fileName), `pattern\n`);
            }

            const result = await tools.fs_grep.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                head_limit: 0,
                description: "test grep",
            });

            const text = unwrapResult(result);
            expect(text).toContain("size limit");
        });

        it("should not trigger fallback for files_with_matches mode", async () => {
            const subDir = path.join(testDir, "many-files-2");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 50; i++) {
                const fileName = `file-${i}.txt`;
                writeFileSync(path.join(subDir, fileName), `pattern match\n`);
            }

            const result = await tools.fs_grep.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "files_with_matches",
                head_limit: 0,
                description: "test grep",
            });

            const text = unwrapResult(result);
            expect(text).not.toContain("size limit");
            expect(text).toContain("file-");
        });

        it("should not trigger fallback for count mode", async () => {
            const largeContent = "pattern match\n".repeat(5000);
            writeFileSync(path.join(testDir, "large-count.txt"), largeContent);

            const result = await tools.fs_grep.execute({
                pattern: "pattern",
                path: testDir,
                output_mode: "count",
                description: "test grep",
            });

            const text = unwrapResult(result);
            expect(text).not.toContain("size limit");
            expect(text).toContain("large-count.txt:");
        });
    });
});
