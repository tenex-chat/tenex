import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Create a mock LocalReportStore that uses current env at check time
class MockLocalReportStore {
    getReportsDir(): string {
        const basePath = process.env.TENEX_BASE_DIR || "/tmp/tenex-default";
        return path.join(basePath, "reports");
    }

    isPathInReportsDir(inputPath: string): boolean {
        const normalizedPath = inputPath.replace(/\\/g, "/");
        const normalizedReportsDir = this.getReportsDir().replace(/\\/g, "/");
        return normalizedPath.startsWith(normalizedReportsDir + "/") ||
               normalizedPath === normalizedReportsDir;
    }
}

const mockStoreInstance = new MockLocalReportStore();

mock.module("@/services/reports", () => ({
    getLocalReportStore: () => mockStoreInstance,
    LocalReportStore: MockLocalReportStore,
    InvalidSlugError: class InvalidSlugError extends Error {
        constructor(slug: string, reason: string) {
            super(`Invalid report slug "${slug}": ${reason}`);
            this.name = "InvalidSlugError";
        }
    },
}));

// Dynamic import after mock setup
const { createFsWriteTool } = await import("../fs_write");

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
                writeTool.execute({
                    path: "test.txt",
                    content: "content",
                })
            ).rejects.toThrow("Path must be absolute");
        });

        it("should accept absolute paths", async () => {
            const filePath = path.join(testDir, "test.txt");

            const result = await writeTool.execute({
                path: filePath,
                content: "new content",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("new content");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block writing outside working directory by default", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");

            try {
                const result = await writeTool.execute({
                    path: outsideFile,
                    content: "malicious content",
                });

                expect(result).toContain("outside your working directory");
                expect(result).toContain("allowOutsideWorkingDirectory: true");
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

        it("should allow writing within working directory without flag", async () => {
            const filePath = path.join(testDir, "inside.txt");

            const result = await writeTool.execute({
                path: filePath,
                content: "inside content",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("inside content");
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

        it("should allow writing inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            // Use the shared getTestAgentHomeDir function for consistent path derivation
            const agentHomeDir = getTestAgentHomeDir(context.agent.pubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            const homeFile = path.join(agentHomeDir, "notes.txt");

            try {
                const result = await writeTool.execute({
                    path: homeFile,
                    content: "my private notes",
                    // NOTE: No allowOutsideWorkingDirectory flag!
                });

                expect(result).toContain("Successfully wrote");
                expect(readFileSync(homeFile, "utf-8")).toBe("my private notes");
            } finally {
                await cleanupTempDir(agentHomeDir);
            }
        });
    });

    describe("basic functionality", () => {
        it("should create parent directories automatically", async () => {
            const filePath = path.join(testDir, "a", "b", "c", "deep.txt");

            const result = await writeTool.execute({
                path: filePath,
                content: "deep content",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("deep content");
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

        it("should handle unicode content", async () => {
            const filePath = path.join(testDir, "unicode.txt");

            const result = await writeTool.execute({
                path: filePath,
                content: "Hello 世界 🌍",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("Hello 世界 🌍");
        });
    });

    describe("getHumanReadableContent", () => {
        it("should return human-readable description", () => {
            const readable = writeTool.getHumanReadableContent?.({ path: "/test/file.txt" });
            expect(readable).toBe("Writing /test/file.txt");
        });
    });

    describe("error handling", () => {
        it("should return error-text for permission denied errors", async () => {
            // Create a read-only directory
            const readOnlyDir = path.join(testDir, "readonly");
            mkdirSync(readOnlyDir, { mode: 0o555 }); // r-xr-xr-x

            try {
                const filePath = path.join(readOnlyDir, "test.txt");
                const result = await writeTool.execute({
                    path: filePath,
                    content: "test content",
                });

                // Should return error-text object, not throw
                expect(result).toEqual({
                    type: "error-text",
                    text: expect.stringMatching(/Permission denied|Access denied/),
                });
            } finally {
                // Restore permissions for cleanup
                const fs = await import("node:fs");
                fs.chmodSync(readOnlyDir, 0o755);
            }
        });
    });

    describe("reports directory protection", () => {
        it("should block writes to the reports directory", async () => {
            // Mock the TENEX_BASE_DIR to control the reports directory location
            const originalEnv = process.env.TENEX_BASE_DIR;
            process.env.TENEX_BASE_DIR = testDir;

            try {
                const reportsFile = path.join(testDir, "reports", "my-report.md");

                await expect(
                    writeTool.execute({
                        path: reportsFile,
                        content: "Trying to bypass report_write",
                        allowOutsideWorkingDirectory: true,
                    })
                ).rejects.toThrow("Cannot write to reports directory directly");
            } finally {
                // Restore original env
                if (originalEnv !== undefined) {
                    process.env.TENEX_BASE_DIR = originalEnv;
                } else {
                    delete process.env.TENEX_BASE_DIR;
                }
            }
        });

        it("should block writes to subdirectories within reports", async () => {
            const originalEnv = process.env.TENEX_BASE_DIR;
            process.env.TENEX_BASE_DIR = testDir;

            try {
                const nestedReportsFile = path.join(testDir, "reports", "subdir", "deep-report.md");

                await expect(
                    writeTool.execute({
                        path: nestedReportsFile,
                        content: "Nested bypass attempt",
                        allowOutsideWorkingDirectory: true,
                    })
                ).rejects.toThrow("Cannot write to reports directory directly");
            } finally {
                if (originalEnv !== undefined) {
                    process.env.TENEX_BASE_DIR = originalEnv;
                } else {
                    delete process.env.TENEX_BASE_DIR;
                }
            }
        });

        it("should include helpful error message pointing to report_write", async () => {
            const originalEnv = process.env.TENEX_BASE_DIR;
            process.env.TENEX_BASE_DIR = testDir;

            try {
                const reportsFile = path.join(testDir, "reports", "test.md");

                await expect(
                    writeTool.execute({
                        path: reportsFile,
                        content: "test",
                        allowOutsideWorkingDirectory: true,
                    })
                ).rejects.toThrow("report_write");
            } finally {
                if (originalEnv !== undefined) {
                    process.env.TENEX_BASE_DIR = originalEnv;
                } else {
                    delete process.env.TENEX_BASE_DIR;
                }
            }
        });
    });
});
