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
const { createFsGlobTool } = await import("../fs_glob");

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

        it("should allow globbing inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            // Use the shared getTestAgentHomeDir function for consistent path derivation
            const agentHomeDir = getTestAgentHomeDir(context.agent.pubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            writeFileSync(path.join(agentHomeDir, "notes.txt"), "my notes");
            writeFileSync(path.join(agentHomeDir, "script.sh"), "echo hello");

            try {
                const result = await globTool.execute({
                    pattern: "*.txt",
                    path: agentHomeDir,
                    // NOTE: No allowOutsideWorkingDirectory flag!
                });

                expect(result).toContain("notes.txt");
                expect(result).not.toContain("outside your working directory");
            } finally {
                await cleanupTempDir(agentHomeDir);
            }
        });

        it("should block path traversal via glob pattern with ../*", async () => {
            // Create a directory structure where traversal could escape
            const parentDir = path.dirname(testDir);
            const escapedFile = path.join(parentDir, "escaped-secret.txt");
            writeFileSync(escapedFile, "escaped content");

            // Create a file inside the working dir for reference
            writeFileSync(path.join(testDir, "inside.txt"), "inside content");

            try {
                const result = await globTool.execute({
                    pattern: "../*",
                    path: testDir,
                });

                // The pattern should NOT match files outside the allowed directory
                // Either it returns "No files found" or filters out the escaped files
                expect(result).not.toContain("escaped-secret.txt");
            } finally {
                // Cleanup - the escaped file is in a temp parent directory
                try {
                    const fs = await import("node:fs");
                    fs.unlinkSync(escapedFile);
                } catch {
                    // Ignore cleanup errors
                }
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
