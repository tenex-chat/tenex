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

describe("fs_glob tool", () => {
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

            const result = await tools.fs_glob.execute({
                pattern: "*.txt",
                description: "Test relative path rejection",
                path: "subdir",
            });

            expect(unwrapResult(result)).toContain("Path must be absolute");
        });

        it("should accept absolute paths", async () => {
            writeFileSync(path.join(testDir, "test.txt"), "content");

            const result = await tools.fs_glob.execute({
                pattern: "*.txt",
                description: "Test absolute path acceptance",
                path: testDir,
            });

            expect(unwrapResult(result)).toContain("test.txt");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block globbing outside working directory by default", async () => {
            const outsideDir = await createTempDir();
            writeFileSync(path.join(outsideDir, "outside.txt"), "content");

            try {
                const result = await tools.fs_glob.execute({
                    pattern: "*.txt",
                    description: "Test outside directory blocking",
                    path: outsideDir,
                });

                const text = unwrapResult(result);
                expect(text).toContain("outside your working directory");
                expect(text).toContain("allowOutsideWorkingDirectory: true");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow globbing outside when flag is set", async () => {
            const outsideDir = await createTempDir();
            writeFileSync(path.join(outsideDir, "outside.txt"), "content");

            try {
                const result = await tools.fs_glob.execute({
                    pattern: "*.txt",
                    description: "Test outside directory with flag",
                    path: outsideDir,
                    allowOutsideWorkingDirectory: true,
                });

                expect(unwrapResult(result)).toContain("outside.txt");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow globbing within working directory without flag", async () => {
            writeFileSync(path.join(testDir, "inside.txt"), "content");

            const result = await tools.fs_glob.execute({
                pattern: "*.txt",
                description: "Test inside directory without flag",
                path: testDir,
            });

            expect(unwrapResult(result)).toContain("inside.txt");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = testDir + "-backup";
            mkdirSync(similarDir, { recursive: true });
            writeFileSync(path.join(similarDir, "sneaky.txt"), "content");

            try {
                const result = await tools.fs_glob.execute({
                    pattern: "*.txt",
                    description: "Test similar path blocking",
                    path: similarDir,
                });

                expect(unwrapResult(result)).toContain("outside your working directory");
            } finally {
                await cleanupTempDir(similarDir);
            }
        });

        it("should allow globbing inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            const agentHomeDir = getTestAgentHomeDir(agentPubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            writeFileSync(path.join(agentHomeDir, "notes.txt"), "my notes");
            writeFileSync(path.join(agentHomeDir, "script.sh"), "echo hello");

            try {
                const result = await tools.fs_glob.execute({
                    pattern: "*.txt",
                    description: "Test agent home directory access",
                    path: agentHomeDir,
                });

                const text = unwrapResult(result);
                expect(text).toContain("notes.txt");
                expect(text).not.toContain("outside your working directory");
            } finally {
                await cleanupTempDir(agentHomeDir);
            }
        });

        it("should block path traversal via glob pattern with ../*", async () => {
            const parentDir = path.dirname(testDir);
            const escapedFile = path.join(parentDir, "escaped-secret.txt");
            writeFileSync(escapedFile, "escaped content");
            writeFileSync(path.join(testDir, "inside.txt"), "inside content");

            try {
                const result = await tools.fs_glob.execute({
                    pattern: "../*",
                    description: "Test path traversal blocking",
                    path: testDir,
                });

                expect(unwrapResult(result)).not.toContain("escaped-secret.txt");
            } finally {
                try {
                    const fs = await import("node:fs");
                    fs.unlinkSync(escapedFile);
                } catch {}
            }
        });
    });

    describe("basic functionality", () => {
        it("should find files matching pattern", async () => {
            writeFileSync(path.join(testDir, "file1.txt"), "content");
            writeFileSync(path.join(testDir, "file2.txt"), "content");
            writeFileSync(path.join(testDir, "file3.js"), "content");

            const result = await tools.fs_glob.execute({
                pattern: "*.txt",
                description: "Find text files",
                path: testDir,
            });

            const text = unwrapResult(result);
            expect(text).toContain("file1.txt");
            expect(text).toContain("file2.txt");
            expect(text).not.toContain("file3.js");
        });

        it("should return no files message when nothing found", async () => {
            const result = await tools.fs_glob.execute({
                pattern: "*.nonexistent",
                description: "Test no files found",
                path: testDir,
            });

            expect(unwrapResult(result)).toContain("No files found");
        });

        it("should support recursive patterns", async () => {
            const subDir = path.join(testDir, "sub");
            mkdirSync(subDir, { recursive: true });
            writeFileSync(path.join(subDir, "nested.txt"), "content");

            const result = await tools.fs_glob.execute({
                pattern: "**/*.txt",
                description: "Find nested text files",
                path: testDir,
            });

            expect(unwrapResult(result)).toContain("nested.txt");
        });
    });
});
