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

// Dynamic import after mock setup
const { createFsEditTool } = await import("../fs_edit");

describe("fs_edit tool", () => {
    let testDir: string;
    let context: ExecutionEnvironment;
    let editTool: ReturnType<typeof createFsEditTool>;

    beforeEach(async () => {
        testDir = await createTempDir();

        // Create test context
        context = {
            workingDirectory: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { name: "TestAgent", slug: "test-agent", pubkey: "pubkey123" },
        } as ExecutionEnvironment;

        // Create tool instance
        editTool = createFsEditTool(context);
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("basic string replacement", () => {
        it("should replace a unique string successfully", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: "World",
                new_string: "Universe",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");

            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("Hello, Universe!");
        });

        it("should handle multi-line string replacements", async () => {
            const filePath = path.join(testDir, "multi.txt");
            const original = `function test() {
    console.log("old");
}`;
            writeFileSync(filePath, original, "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: 'console.log("old");',
                new_string: 'console.log("new");',
            });

            expect(result).toContain("Successfully replaced 1 occurrence");

            const content = readFileSync(filePath, "utf-8");
            expect(content).toContain('console.log("new");');
        });

        it("should handle larger context for uniqueness", async () => {
            const filePath = path.join(testDir, "context.txt");
            const original = `line 1
line 2
line 3
line 4`;
            writeFileSync(filePath, original, "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: `line 2
line 3`,
                new_string: `line 2
modified line 3`,
            });

            expect(result).toContain("Successfully replaced 1 occurrence");

            const content = readFileSync(filePath, "utf-8");
            expect(content).toContain("modified line 3");
        });
    });

    describe("replace_all functionality", () => {
        it("should replace all occurrences when replace_all is true", async () => {
            const filePath = path.join(testDir, "multiple.txt");
            writeFileSync(filePath, "foo bar foo baz foo", "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: "foo",
                new_string: "qux",
                replace_all: true,
            });

            expect(result).toContain("Successfully replaced 3 occurrence(s)");

            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("qux bar qux baz qux");
        });

        it("should return error-text when string is not unique and replace_all is false", async () => {
            const filePath = path.join(testDir, "duplicate.txt");
            writeFileSync(filePath, "test test test", "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: "test",
                new_string: "replaced",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("appears multiple times"),
            });
        });

        it("should handle special regex characters in replace_all", async () => {
            const filePath = path.join(testDir, "special.txt");
            writeFileSync(filePath, "a.b a.b a.b", "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: "a.b",
                new_string: "c.d",
                replace_all: true,
            });

            expect(result).toContain("Successfully replaced 3 occurrence(s)");

            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("c.d c.d c.d");
        });
    });

    describe("error handling", () => {
        it("should return error-text when old_string is not found", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: "NotFound",
                new_string: "Replaced",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("old_string not found"),
            });
        });

        it("should return error-text when old_string and new_string are identical", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: "World",
                new_string: "World",
            });

            expect(result).toEqual({
                type: "error-text",
                text: "old_string and new_string must be different",
            });
        });

        it("should reject relative paths", async () => {
            await expect(
                editTool.execute({
                    path: "../../../etc/passwd",
                    old_string: "old",
                    new_string: "new",
                })
            ).rejects.toThrow("Path must be absolute");
        });

        it("should return error-text when file does not exist", async () => {
            const nonExistent = path.join(testDir, "nonexistent.txt");
            const result = await editTool.execute({
                path: nonExistent,
                old_string: "old",
                new_string: "new",
            });
            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("File or directory not found"),
            });
        });

        it("should return error-text when old_string equals new_string", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "some content", "utf-8");
            const result = await editTool.execute({
                path: filePath,
                old_string: "same",
                new_string: "same",
            });
            expect(result).toEqual({
                type: "error-text",
                text: "old_string and new_string must be different",
            });
        });

        it("should return error-text when old_string not found in file", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "some content", "utf-8");
            const result = await editTool.execute({
                path: filePath,
                old_string: "not in file",
                new_string: "replacement",
            });
            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("old_string not found"),
            });
        });

        it("should return error-text when old_string appears multiple times", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "hello world hello world", "utf-8");
            const result = await editTool.execute({
                path: filePath,
                old_string: "hello",
                new_string: "goodbye",
            });
            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("appears multiple times"),
            });
        });
    });

    describe("edge cases", () => {
        it("should handle empty string replacement", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: ", ",
                new_string: "",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");

            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("HelloWorld!");
        });

        it("should handle unicode content", async () => {
            const filePath = path.join(testDir, "unicode.txt");
            writeFileSync(filePath, "你好世界 🌍", "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: "世界",
                new_string: "宇宙",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");

            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("你好宇宙 🌍");
        });

        it("should handle absolute paths", async () => {
            const absolutePath = path.join(testDir, "absolute.txt");
            writeFileSync(absolutePath, "Original content", "utf-8");

            const result = await editTool.execute({
                path: absolutePath,
                old_string: "Original",
                new_string: "Modified",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");

            const content = readFileSync(absolutePath, "utf-8");
            expect(content).toBe("Modified content");
        });

        it("should handle files in subdirectories", async () => {
            const filePath = path.join(testDir, "subdir", "nested.txt");
            const fs = await import("node:fs/promises");
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, "Test content", "utf-8");

            const result = await editTool.execute({
                path: filePath,
                old_string: "Test",
                new_string: "Updated",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");

            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("Updated content");
        });
    });

    describe("getHumanReadableContent", () => {
        it("should return human-readable description", () => {
            const readable = editTool.getHumanReadableContent?.({ path: "test.txt" });
            expect(readable).toBe("Editing test.txt");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block editing outside working directory by default", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "original content");

            try {
                const result = await editTool.execute({
                    path: outsideFile,
                    old_string: "original",
                    new_string: "modified",
                });

                expect(result).toContain("outside your working directory");
                expect(result).toContain("allowOutsideWorkingDirectory: true");
                // File should NOT be modified
                expect(readFileSync(outsideFile, "utf-8")).toBe("original content");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow editing outside when flag is set", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "original content");

            try {
                const result = await editTool.execute({
                    path: outsideFile,
                    old_string: "original",
                    new_string: "modified",
                    allowOutsideWorkingDirectory: true,
                });

                expect(result).toContain("Successfully replaced");
                expect(readFileSync(outsideFile, "utf-8")).toBe("modified content");
            } finally {
                await cleanupTempDir(outsideDir);
            }
        });

        it("should allow editing files within working directory without flag", async () => {
            const filePath = path.join(testDir, "inside.txt");
            writeFileSync(filePath, "original content");

            const result = await editTool.execute({
                path: filePath,
                old_string: "original",
                new_string: "modified",
            });

            expect(result).toContain("Successfully replaced");
            expect(readFileSync(filePath, "utf-8")).toBe("modified content");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = testDir + "-backup";
            mkdirSync(similarDir, { recursive: true });
            const outsideFile = path.join(similarDir, "sneaky.txt");
            writeFileSync(outsideFile, "original content");

            try {
                const result = await editTool.execute({
                    path: outsideFile,
                    old_string: "original",
                    new_string: "modified",
                });

                expect(result).toContain("outside your working directory");
            } finally {
                await cleanupTempDir(similarDir);
            }
        });

        it("should allow editing inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            // Use the shared getTestAgentHomeDir function for consistent path derivation
            const agentHomeDir = getTestAgentHomeDir(context.agent.pubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            const homeFile = path.join(agentHomeDir, "notes.txt");
            writeFileSync(homeFile, "original notes");

            try {
                const result = await editTool.execute({
                    path: homeFile,
                    old_string: "original",
                    new_string: "modified",
                    // NOTE: No allowOutsideWorkingDirectory flag!
                });

                expect(result).toContain("Successfully replaced");
                expect(readFileSync(homeFile, "utf-8")).toBe("modified notes");
            } finally {
                await cleanupTempDir(agentHomeDir);
            }
        });
    });
});
