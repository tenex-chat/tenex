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
const { createFsGrepTool } = await import("../fs_grep");

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

        it("should allow searching inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            // Use the shared getTestAgentHomeDir function for consistent path derivation
            const agentHomeDir = getTestAgentHomeDir(context.agent.pubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            writeFileSync(path.join(agentHomeDir, "notes.txt"), "my secret notes");

            try {
                const result = await grepTool.execute({
                    pattern: "secret",
                    path: agentHomeDir,
                    // NOTE: No allowOutsideWorkingDirectory flag!
                });

                expect(result).toContain("notes.txt");
                expect(result).not.toContain("outside your working directory");
            } finally {
                await cleanupTempDir(agentHomeDir);
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

    describe("auto-fallback for large content", () => {
        it("should return normal content output when under 50KB threshold", async () => {
            // Create a file with moderate content (well under 50KB)
            const content = "test line with pattern\n".repeat(100);
            writeFileSync(path.join(testDir, "small.txt"), content);

            const result = await grepTool.execute({
                pattern: "pattern",
                path: testDir,
                output_mode: "content",
                head_limit: 0, // unlimited
            });

            // Should return actual content, not fallback
            expect(result).toContain("test line with pattern");
            expect(result).not.toContain("Content output would exceed 50KB limit");
        });

        it("should fallback to file list when single large file exceeds 50KB", async () => {
            // Create a large log file that will produce >50KB of matches
            // Each line is ~50 chars, need >1000 lines to exceed 50KB
            const logLine = "2024-01-01 12:00:00 [INFO] pattern match here\n";
            const largeContent = logLine.repeat(2000);
            writeFileSync(path.join(testDir, "large.log"), largeContent);

            const result = await grepTool.execute({
                pattern: "pattern",
                path: testDir,
                output_mode: "content",
                head_limit: 0, // unlimited
            });

            // Should fallback to file list
            expect(result).toContain("Content output would exceed 50KB limit");
            expect(result).toContain("matching files instead");
            expect(result).toContain("large.log");
            // Should NOT contain actual content
            expect(result).not.toContain("INFO");
        });

        it("should fallback to file list when many small files exceed 50KB total", async () => {
            // Create many small files that together exceed 50KB
            // Each file output is: "many-files/file-XXXX.txt:1:test pattern match in file XXX\n"
            // That's roughly 60 chars per file. Need ~850 files to exceed 50KB
            const subDir = path.join(testDir, "many-files");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 900; i++) {
                const fileName = `file-${i.toString().padStart(4, "0")}.txt`;
                writeFileSync(path.join(subDir, fileName), `test pattern match in file ${i}\n`);
            }

            const result = await grepTool.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                head_limit: 0, // unlimited
            });

            // Should fallback to file list
            expect(result).toContain("Content output would exceed 50KB limit");
            expect(result).toContain("matching files instead");
            expect(result).toContain("file-");
            // Should NOT contain actual content
            expect(result).not.toContain("test pattern match");
        });

        it("should truncate file list when even that exceeds 50KB", async () => {
            // Create an absurd number of files so even the file list is too large
            // Each file path is ~50 chars, need >1000 files to exceed 50KB in file list
            const subDir = path.join(testDir, "absurd-files");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 1500; i++) {
                const fileName = `very-long-filename-to-increase-path-length-${i.toString().padStart(5, "0")}.txt`;
                writeFileSync(path.join(subDir, fileName), `pattern\n`);
            }

            const result = await grepTool.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                head_limit: 0, // unlimited
            });

            // Should indicate fallback to file list
            expect(result).toContain("Content output would exceed 50KB limit");
            expect(result).toContain("matching files instead");
            // Should enforce hard cap - output must not exceed 50KB
            const outputSize = Buffer.byteLength(result, "utf8");
            expect(outputSize).toBeLessThanOrEqual(50_000);
        });

        it("should not trigger fallback when pagination keeps output under 50KB", async () => {
            // Create many files with content
            const subDir = path.join(testDir, "paginated-files");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 500; i++) {
                const fileName = `file-${i.toString().padStart(4, "0")}.txt`;
                writeFileSync(path.join(subDir, fileName), `test pattern match in file ${i}\n`);
            }

            // Use head_limit to keep output small
            const result = await grepTool.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                head_limit: 100, // Only first 100 lines
            });

            // Should NOT trigger fallback because pagination keeps output small
            expect(result).not.toContain("Content output would exceed 50KB limit");
            expect(result).toContain("test pattern match");
            // Should show truncation notice
            expect(result).toContain("[Truncated: showing 100 of");
        });

        it("should respect offset in fallback file list", async () => {
            // Create many files that will trigger fallback even after pagination
            const subDir = path.join(testDir, "offset-test");
            mkdirSync(subDir, { recursive: true });

            // Create files with enough content to exceed 50KB with just 200 lines
            for (let i = 0; i < 900; i++) {
                const fileName = `file-${i.toString().padStart(4, "0")}.txt`;
                // Each line ~300 chars, 200 lines = 60KB
                const longContent = "pattern match ".repeat(20) + i.toString();
                writeFileSync(path.join(subDir, fileName), `${longContent}\n`);
            }

            // Use offset and head_limit, but output still exceeds 50KB
            const result = await grepTool.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                offset: 50,
                head_limit: 200,
            });

            // Should fallback due to large paginated content
            expect(result).toContain("Content output would exceed 50KB limit");
            // File list should respect pagination
            const lines = result.split("\n").filter((l) => l.includes("file-"));
            expect(lines.length).toBeGreaterThan(0);
            expect(lines.length).toBeLessThanOrEqual(200);
        });

        it("should enforce hard cap on fallback output", async () => {
            // Create many files with long paths
            const subDir = path.join(testDir, "hard-cap-test");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 1500; i++) {
                const fileName = `very-long-filename-that-makes-path-bigger-${i.toString().padStart(5, "0")}.txt`;
                writeFileSync(path.join(subDir, fileName), `pattern\n`);
            }

            const result = await grepTool.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "content",
                head_limit: 0,
            });

            // Must enforce 50KB hard cap
            const outputSize = Buffer.byteLength(result, "utf8");
            expect(outputSize).toBeLessThanOrEqual(50_000);
            expect(result).toContain("Content output would exceed 50KB limit");
        });

        it("should not trigger fallback for files_with_matches mode", async () => {
            // Create many files
            const subDir = path.join(testDir, "many-files-2");
            mkdirSync(subDir, { recursive: true });

            for (let i = 0; i < 50; i++) {
                const fileName = `file-${i}.txt`;
                writeFileSync(path.join(subDir, fileName), `pattern match\n`);
            }

            const result = await grepTool.execute({
                pattern: "pattern",
                path: subDir,
                output_mode: "files_with_matches",
                head_limit: 0,
            });

            // Should NOT show fallback message (already in file mode)
            expect(result).not.toContain("Content output would exceed 50KB limit");
            expect(result).toContain("file-");
        });

        it("should not trigger fallback for count mode", async () => {
            // Create a large file
            const largeContent = "pattern match\n".repeat(5000);
            writeFileSync(path.join(testDir, "large-count.txt"), largeContent);

            const result = await grepTool.execute({
                pattern: "pattern",
                path: testDir,
                output_mode: "count",
            });

            // Should NOT show fallback message (count mode is always small)
            expect(result).not.toContain("Content output would exceed 50KB limit");
            expect(result).toContain("large-count.txt:");
        });
    });
});
