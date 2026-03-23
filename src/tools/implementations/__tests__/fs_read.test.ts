import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { isAbsolute, relative, resolve, normalize } from "node:path";
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

describe("fs_read tool", () => {
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
            writeFileSync(path.join(testDir, "test.txt"), "content");

            const result = await tools.fs_read.execute({
                path: "test.txt",
                description: "test read",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("Path must be absolute"),
            });
        });

        it("should accept absolute paths", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "file content here");

            const result = await tools.fs_read.execute({
                path: filePath,
                description: "test read",
            });

            expect(result).toContain("file content here");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block reading outside working directory by default", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "secret content");

            try {
                const result = await tools.fs_read.execute({
                    path: outsideFile,
                    description: "test read",
                });

                expect(result).toEqual({
                    type: "error-text",
                    text: expect.stringContaining("outside your working directory"),
                });
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow reading outside when flag is set", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "allowed content");

            try {
                const result = await tools.fs_read.execute({
                    path: outsideFile,
                    description: "test read",
                    allowOutsideWorkingDirectory: true,
                });

                expect(result).toContain("allowed content");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow reading within working directory without flag", async () => {
            const filePath = path.join(testDir, "inside.txt");
            writeFileSync(filePath, "inside content");

            const result = await tools.fs_read.execute({
                path: filePath,
                description: "test read",
            });

            expect(result).toContain("inside content");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = `${testDir}-backup`;
            mkdirSync(similarDir, { recursive: true });
            const outsideFile = path.join(similarDir, "sneaky.txt");
            writeFileSync(outsideFile, "sneaky content");

            try {
                const result = await tools.fs_read.execute({
                    path: outsideFile,
                    description: "test read",
                });

                expect(result).toEqual({
                    type: "error-text",
                    text: expect.stringContaining("outside your working directory"),
                });
            } finally {
                await cleanupTempDir(similarDir);
            }
        });

        it("should allow reading inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            const agentHomeDir = getTestAgentHomeDir(agentPubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            const homeFile = path.join(agentHomeDir, "notes.txt");
            writeFileSync(homeFile, "my private notes");

            try {
                const result = await tools.fs_read.execute({
                    path: homeFile,
                    description: "reading notes",
                });

                expect(result).toContain("my private notes");
            } finally {
                await cleanupTempDir(agentHomeDir);
            }
        });
    });

    describe("basic functionality", () => {
        it("should read file content with line numbers", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "line 1\nline 2\nline 3");

            const result = await tools.fs_read.execute({
                path: filePath,
                description: "test read",
            });

            expect(result).toContain("1\tline 1");
            expect(result).toContain("2\tline 2");
            expect(result).toContain("3\tline 3");
        });

        it("should list directory contents", async () => {
            writeFileSync(path.join(testDir, "file1.txt"), "content");
            writeFileSync(path.join(testDir, "file2.txt"), "content");

            const result = await tools.fs_read.execute({
                path: testDir,
                description: "list dir",
            });

            expect(result).toContain("Directory listing");
            expect(result).toContain("file1.txt");
            expect(result).toContain("file2.txt");
        });

        it("should support offset and limit", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "line 1\nline 2\nline 3\nline 4\nline 5");

            const result = await tools.fs_read.execute({
                path: filePath,
                description: "test read",
                offset: 2,
                limit: 2,
            });

            expect(result).toContain("2\tline 2");
            expect(result).toContain("3\tline 3");
            expect(result).not.toContain("1\tline 1");
            expect(result).not.toContain("4\tline 4");
        });
    });

    describe("expected error handling", () => {
        it("should return error-text object for non-existent file (ENOENT)", async () => {
            const nonExistentPath = path.join(testDir, "does-not-exist.txt");

            const result = await tools.fs_read.execute({
                path: nonExistentPath,
                description: "test read non-existent",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("File or directory not found"),
            });
        });

        it("should return directory listing for directory path", async () => {
            const dirPath = path.join(testDir, "subdir");
            mkdirSync(dirPath, { recursive: true });

            const result = await tools.fs_read.execute({
                path: dirPath,
                description: "test read directory",
            });

            expect(result).toContain("Directory listing");
        });
    });
});
