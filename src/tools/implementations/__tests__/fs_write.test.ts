import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createFsTools, type FsToolName, type FsToolSet } from "ai-sdk-fs-tools";
import { cleanupTempDir, createTempDir } from "@/test-utils";

const TEST_HOME_BASE = "/tmp/tenex/home";
const getTestAgentHomeDir = (pubkey: string) => `${TEST_HOME_BASE}/${pubkey.slice(0, 8)}`;

function createTestFsTools(workingDirectory: string, agentPubkey: string, reportsDir?: string): FsToolSet {
    return createFsTools({
        workingDirectory,
        allowedRoots: [getTestAgentHomeDir(agentPubkey)],
        agentsMd: false,
        formatOutsideRootsError: (p, wd) =>
            `Path "${p}" is outside your working directory "${wd}". If this was intentional, retry with allowOutsideWorkingDirectory: true`,
        beforeExecute: reportsDir
            ? (toolName: FsToolName, input: Record<string, unknown>) => {
                const p = input.path as string | undefined;
                if (p && (toolName === "fs_write" || toolName === "fs_edit")) {
                    if (p.startsWith(reportsDir + "/") || p === reportsDir) {
                        throw new Error(
                            `Cannot write to reports directory directly. Path "${p}" is within the protected reports directory. Use the report_write tool instead.`
                        );
                    }
                }
            }
            : undefined,
    });
}

describe("fs_write tool", () => {
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
            const result = await tools.fs_write.execute({
                path: "test.txt",
                content: "content",
                description: "test write",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("Path must be absolute"),
            });
        });

        it("should accept absolute paths", async () => {
            const filePath = path.join(testDir, "test.txt");

            const result = await tools.fs_write.execute({
                path: filePath,
                content: "new content",
                description: "test write",
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
                const result = await tools.fs_write.execute({
                    path: outsideFile,
                    content: "malicious content",
                    description: "test write",
                });

                expect(result).toEqual({
                    type: "error-text",
                    text: expect.stringContaining("outside your working directory"),
                });
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow writing outside when flag is set", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");

            try {
                const result = await tools.fs_write.execute({
                    path: outsideFile,
                    content: "allowed content",
                    allowOutsideWorkingDirectory: true,
                    description: "test write",
                });

                expect(result).toContain("Successfully wrote");
                expect(readFileSync(outsideFile, "utf-8")).toBe("allowed content");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow writing within working directory without flag", async () => {
            const filePath = path.join(testDir, "inside.txt");

            const result = await tools.fs_write.execute({
                path: filePath,
                content: "inside content",
                description: "test write",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("inside content");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = testDir + "-backup";
            mkdirSync(similarDir, { recursive: true });
            const outsideFile = path.join(similarDir, "sneaky.txt");

            try {
                const result = await tools.fs_write.execute({
                    path: outsideFile,
                    content: "sneaky content",
                    description: "test write",
                });

                expect(result).toEqual({
                    type: "error-text",
                    text: expect.stringContaining("outside your working directory"),
                });
            } finally {
                await cleanupTempDir(similarDir);
            }
        });

        it("should allow writing inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            const agentHomeDir = getTestAgentHomeDir(agentPubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            const homeFile = path.join(agentHomeDir, "notes.txt");

            try {
                const result = await tools.fs_write.execute({
                    path: homeFile,
                    content: "my private notes",
                    description: "test write",
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

            const result = await tools.fs_write.execute({
                path: filePath,
                content: "deep content",
                description: "test write",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("deep content");
        });

        it("should overwrite existing files", async () => {
            const filePath = path.join(testDir, "existing.txt");
            writeFileSync(filePath, "old content");

            const result = await tools.fs_write.execute({
                path: filePath,
                content: "new content",
                description: "test write",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("new content");
        });

        it("should handle unicode content", async () => {
            const filePath = path.join(testDir, "unicode.txt");

            const result = await tools.fs_write.execute({
                path: filePath,
                content: "Hello 世界 🌍",
                description: "test write",
            });

            expect(result).toContain("Successfully wrote");
            expect(readFileSync(filePath, "utf-8")).toBe("Hello 世界 🌍");
        });
    });

    describe("error handling", () => {
        it("should return error-text for permission denied errors", async () => {
            const readOnlyDir = path.join(testDir, "readonly");
            mkdirSync(readOnlyDir, { mode: 0o555 });

            try {
                const filePath = path.join(readOnlyDir, "test.txt");
                const result = await tools.fs_write.execute({
                    path: filePath,
                    content: "test content",
                    description: "test write",
                });

                expect(result).toEqual({
                    type: "error-text",
                    text: expect.stringMatching(/Permission denied|Access denied/),
                });
            } finally {
                const fs = await import("node:fs");
                fs.chmodSync(readOnlyDir, 0o755);
            }
        });
    });

    describe("reports directory protection", () => {
        it("should block writes to the reports directory", async () => {
            const reportsDir = path.join(testDir, "reports");
            mkdirSync(reportsDir, { recursive: true });
            const protectedTools = createTestFsTools(testDir, agentPubkey, reportsDir);
            const reportsFile = path.join(reportsDir, "my-report.md");

            const result = await protectedTools.fs_write.execute({
                path: reportsFile,
                content: "Trying to bypass report_write",
                allowOutsideWorkingDirectory: true,
                description: "test write",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("Cannot write to reports directory directly"),
            });
        });

        it("should block writes to subdirectories within reports", async () => {
            const reportsDir = path.join(testDir, "reports");
            mkdirSync(reportsDir, { recursive: true });
            const protectedTools = createTestFsTools(testDir, agentPubkey, reportsDir);
            const nestedReportsFile = path.join(reportsDir, "subdir", "deep-report.md");

            const result = await protectedTools.fs_write.execute({
                path: nestedReportsFile,
                content: "Nested bypass attempt",
                allowOutsideWorkingDirectory: true,
                description: "test write",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("Cannot write to reports directory directly"),
            });
        });

        it("should include helpful error message pointing to report_write", async () => {
            const reportsDir = path.join(testDir, "reports");
            mkdirSync(reportsDir, { recursive: true });
            const protectedTools = createTestFsTools(testDir, agentPubkey, reportsDir);
            const reportsFile = path.join(reportsDir, "test.md");

            const result = await protectedTools.fs_write.execute({
                path: reportsFile,
                content: "test",
                allowOutsideWorkingDirectory: true,
                description: "test write",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("report_write"),
            });
        });
    });
});
