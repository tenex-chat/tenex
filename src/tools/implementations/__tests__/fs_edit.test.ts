import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

describe("fs_edit tool", () => {
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

    describe("basic string replacement", () => {
        it("should replace a unique string successfully", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "World",
                new_string: "Universe",
                description: "edit file",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");
            expect(readFileSync(filePath, "utf-8")).toBe("Hello, Universe!");
        });

        it("should handle multi-line string replacements", async () => {
            const filePath = path.join(testDir, "multi.txt");
            const original = `function test() {
    console.log("old");
}`;
            writeFileSync(filePath, original, "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: 'console.log("old");',
                new_string: 'console.log("new");',
                description: "edit file",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");
            expect(readFileSync(filePath, "utf-8")).toContain('console.log("new");');
        });

        it("should handle larger context for uniqueness", async () => {
            const filePath = path.join(testDir, "context.txt");
            const original = `line 1
line 2
line 3
line 4`;
            writeFileSync(filePath, original, "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: `line 2
line 3`,
                new_string: `line 2
modified line 3`,
                description: "edit file",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");
            expect(readFileSync(filePath, "utf-8")).toContain("modified line 3");
        });
    });

    describe("replace_all functionality", () => {
        it("should replace all occurrences when replace_all is true", async () => {
            const filePath = path.join(testDir, "multiple.txt");
            writeFileSync(filePath, "foo bar foo baz foo", "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "foo",
                new_string: "qux",
                replace_all: true,
                description: "edit file",
            });

            expect(result).toContain("Successfully replaced 3 occurrence(s)");
            expect(readFileSync(filePath, "utf-8")).toBe("qux bar qux baz qux");
        });

        it("should return error-text when string is not unique and replace_all is false", async () => {
            const filePath = path.join(testDir, "duplicate.txt");
            writeFileSync(filePath, "test test test", "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "test",
                new_string: "replaced",
                description: "edit file",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("appears multiple times"),
            });
        });

        it("should handle special regex characters in replace_all", async () => {
            const filePath = path.join(testDir, "special.txt");
            writeFileSync(filePath, "a.b a.b a.b", "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "a.b",
                new_string: "c.d",
                replace_all: true,
                description: "edit file",
            });

            expect(result).toContain("Successfully replaced 3 occurrence(s)");
            expect(readFileSync(filePath, "utf-8")).toBe("c.d c.d c.d");
        });
    });

    describe("error handling", () => {
        it("should return error-text when old_string is not found", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "NotFound",
                new_string: "Replaced",
                description: "edit file",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("old_string not found"),
            });
        });

        it("should return error-text when old_string and new_string are identical", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "World",
                new_string: "World",
                description: "edit file",
            });

            expect(result).toEqual({
                type: "error-text",
                text: "old_string and new_string must be different",
            });
        });

        it("should return error-text for relative paths", async () => {
            const result = await tools.fs_edit.execute({
                path: "../../../etc/passwd",
                old_string: "old",
                new_string: "new",
                description: "edit file",
            });

            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("Path must be absolute"),
            });
        });

        it("should return error-text when file does not exist", async () => {
            const nonExistent = path.join(testDir, "nonexistent.txt");
            const result = await tools.fs_edit.execute({
                path: nonExistent,
                old_string: "old",
                new_string: "new",
                description: "edit file",
            });
            expect(result).toEqual({
                type: "error-text",
                text: expect.stringContaining("File or directory not found"),
            });
        });

        it("should return error-text when old_string appears multiple times", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "hello world hello world", "utf-8");
            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "hello",
                new_string: "goodbye",
                description: "edit file",
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

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: ", ",
                new_string: "",
                description: "edit file",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");
            expect(readFileSync(filePath, "utf-8")).toBe("HelloWorld!");
        });

        it("should handle unicode content", async () => {
            const filePath = path.join(testDir, "unicode.txt");
            writeFileSync(filePath, "你好世界 🌍", "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "世界",
                new_string: "宇宙",
                description: "edit file",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");
            expect(readFileSync(filePath, "utf-8")).toBe("你好宇宙 🌍");
        });

        it("should handle files in subdirectories", async () => {
            const filePath = path.join(testDir, "subdir", "nested.txt");
            const fs = await import("node:fs/promises");
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, "Test content", "utf-8");

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "Test",
                new_string: "Updated",
                description: "edit file",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");
            expect(readFileSync(filePath, "utf-8")).toBe("Updated content");
        });
    });

    describe("allowOutsideWorkingDirectory", () => {
        it("should block editing outside working directory by default", async () => {
            const outsideDir = await createTempDir();
            const outsideFile = path.join(outsideDir, "outside.txt");
            writeFileSync(outsideFile, "original content");

            try {
                const result = await tools.fs_edit.execute({
                    path: outsideFile,
                    old_string: "original",
                    new_string: "modified",
                    description: "edit file",
                });

                expect(result).toEqual({
                    type: "error-text",
                    text: expect.stringContaining("outside your working directory"),
                });
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
                const result = await tools.fs_edit.execute({
                    path: outsideFile,
                    old_string: "original",
                    new_string: "modified",
                    allowOutsideWorkingDirectory: true,
                    description: "edit file",
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

            const result = await tools.fs_edit.execute({
                path: filePath,
                old_string: "original",
                new_string: "modified",
                description: "edit file",
            });

            expect(result).toContain("Successfully replaced");
            expect(readFileSync(filePath, "utf-8")).toBe("modified content");
        });

        it("should block paths that look similar but are outside", async () => {
            const similarDir = `${testDir}-backup`;
            mkdirSync(similarDir, { recursive: true });
            const outsideFile = path.join(similarDir, "sneaky.txt");
            writeFileSync(outsideFile, "original content");

            try {
                const result = await tools.fs_edit.execute({
                    path: outsideFile,
                    old_string: "original",
                    new_string: "modified",
                    description: "edit file",
                });

                expect(result).toEqual({
                    type: "error-text",
                    text: expect.stringContaining("outside your working directory"),
                });
            } finally {
                await cleanupTempDir(similarDir);
            }
        });

        it("should allow editing inside agent home directory without allowOutsideWorkingDirectory flag", async () => {
            const agentHomeDir = getTestAgentHomeDir(agentPubkey);
            mkdirSync(agentHomeDir, { recursive: true });
            const homeFile = path.join(agentHomeDir, "notes.txt");
            writeFileSync(homeFile, "original notes");

            try {
                const result = await tools.fs_edit.execute({
                    path: homeFile,
                    old_string: "original",
                    new_string: "modified",
                    description: "edit file",
                });

                expect(result).toContain("Successfully replaced");
                expect(readFileSync(homeFile, "utf-8")).toBe("modified notes");
            } finally {
                await cleanupTempDir(agentHomeDir);
            }
        });
    });
});
