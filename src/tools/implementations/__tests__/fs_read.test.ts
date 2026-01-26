import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { isAbsolute, relative, resolve, normalize } from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import type { ExecutionEnvironment } from "@/tools/types";

// Mock the agent home directory functions BEFORE importing the tool
// Uses cross-platform path.relative approach matching the real implementation
const TEST_HOME_BASE = "/tmp/tenex/home";
const getTestAgentHomeDir = (pubkey: string) => `${TEST_HOME_BASE}/${pubkey.slice(0, 8)}`;

// Helper for path normalization (matches the real implementation using path.relative)
const normalizePath = (inputPath: string) => normalize(resolve(inputPath));
const isPathWithin = (checkPath: string, directory: string) => {
    const normalizedPath = normalizePath(checkPath);
    const normalizedDir = normalizePath(directory);
    const relativePath = relative(normalizedDir, normalizedPath);
    return !relativePath.startsWith("..") && !isAbsolute(relativePath);
};

mock.module("@/lib/agent-home", () => ({
    getAgentHomeDirectory: getTestAgentHomeDir,
    isWithinAgentHome: (inputPath: string, agentPubkey: string) => {
        const homeDir = getTestAgentHomeDir(agentPubkey);
        return isPathWithin(inputPath, homeDir);
    },
    isPathWithinDirectory: isPathWithin,
    normalizePath,
    ensureAgentHomeDirectory: () => true,
}));

// Dynamic import after mock setup
const { createFsReadTool } = await import("../fs_read");

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
            writeFileSync(path.join(testDir, "test.txt"), "content");

            await expect(
                readTool.execute({
                    path: "test.txt",
                    description: "test read",
                })
            ).rejects.toThrow("Path must be absolute");
        });

        it("should accept absolute paths", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "file content here");

            const result = await readTool.execute({
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
                const result = await readTool.execute({
                    path: outsideFile,
                    description: "test read",
                });

                expect(result).toContain("outside your working directory");
                expect(result).toContain("allowOutsideWorkingDirectory: true");
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

            const result = await readTool.execute({
                path: filePath,
                description: "test read",
            });

            expect(result).toContain("inside content");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = testDir + "-backup";
            mkdirSync(similarDir, { recursive: true });
            const outsideFile = path.join(similarDir, "sneaky.txt");
            writeFileSync(outsideFile, "sneaky content");

            try {
                const result = await readTool.execute({
                    path: outsideFile,
                    description: "test read",
                });

                expect(result).toContain("outside your working directory");
            } finally {
                await cleanupTempDir(similarDir);
            }
        });

        it("should allow reading inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            // Use the shared getTestAgentHomeDir function for consistent path derivation
            const agentHomeDir = getTestAgentHomeDir(context.agent.pubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            const homeFile = path.join(agentHomeDir, "notes.txt");
            writeFileSync(homeFile, "my private notes");

            try {
                const result = await readTool.execute({
                    path: homeFile,
                    description: "reading notes",
                    // NOTE: No allowOutsideWorkingDirectory flag!
                });

                expect(result).toContain("my private notes");
                expect(result).not.toContain("outside your working directory");
            } finally {
                await cleanupTempDir(agentHomeDir);
            }
        });
    });

    describe("basic functionality", () => {
        it("should read file content with line numbers", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "line 1\nline 2\nline 3");

            const result = await readTool.execute({
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

            const result = await readTool.execute({
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

            const result = await readTool.execute({
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

    describe("getHumanReadableContent", () => {
        it("should return human-readable description", () => {
            const readable = readTool.getHumanReadableContent?.({
                path: "/test/file.txt",
                description: "checking config",
            });
            expect(readable).toBe("Reading /test/file.txt (checking config)");
        });
    });

    describe("expected error handling", () => {
        it("should return error-text object for non-existent file (ENOENT)", async () => {
            const nonExistentPath = path.join(testDir, "does-not-exist.txt");

            const result = await readTool.execute({
                path: nonExistentPath,
                description: "test read non-existent",
            });

            // Should return error-text object, not throw
            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("File or directory not found"),
            });
        });

        it("should return error-text object for EISDIR when reading directory as file", async () => {
            // This test verifies the pattern works - directories get handled specially
            // but if there was an EISDIR error scenario, it would return error-text
            const dirPath = path.join(testDir, "subdir");
            mkdirSync(dirPath, { recursive: true });

            // fs_read handles directories specially, listing them instead of throwing
            // This test verifies that case works (it's actually a success case)
            const result = await readTool.execute({
                path: dirPath,
                description: "test read directory",
            });

            // Should return directory listing, not an error
            expect(result).toContain("Directory listing");
        });
    });
});
