import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import type { ToolContext } from "@/tools/types";
import { createEditTool } from "../edit";

describe("edit tool", () => {
    let testDir: string;
    let context: ToolContext;
    let editTool: ReturnType<typeof createEditTool>;

    beforeEach(async () => {
        testDir = await createTempDir();

        // Create test context
        context = {
            workingDirectory: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { name: "TestAgent", slug: "test-agent", pubkey: "pubkey123" },
        } as ToolContext;

        // Create tool instance
        editTool = createEditTool(context);
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("basic string replacement", () => {
        it("should replace a unique string successfully", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            const result = await editTool.execute({
                path: "test.txt",
                old_string: "World",
                new_string: "Universe",
            });

            expect(result).toContain("Successfully replaced 1 occurrence");
            expect(result).toContain("test.txt");

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
                path: "multi.txt",
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
                path: "context.txt",
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
                path: "multiple.txt",
                old_string: "foo",
                new_string: "qux",
                replace_all: true,
            });

            expect(result).toContain("Successfully replaced 3 occurrence(s)");

            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("qux bar qux baz qux");
        });

        it("should fail when string is not unique and replace_all is false", async () => {
            const filePath = path.join(testDir, "duplicate.txt");
            writeFileSync(filePath, "test test test", "utf-8");

            await expect(
                editTool.execute({
                    path: "duplicate.txt",
                    old_string: "test",
                    new_string: "replaced",
                })
            ).rejects.toThrow("old_string appears multiple times");
        });

        it("should handle special regex characters in replace_all", async () => {
            const filePath = path.join(testDir, "special.txt");
            writeFileSync(filePath, "a.b a.b a.b", "utf-8");

            const result = await editTool.execute({
                path: "special.txt",
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
        it("should fail when old_string is not found", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            await expect(
                editTool.execute({
                    path: "test.txt",
                    old_string: "NotFound",
                    new_string: "Replaced",
                })
            ).rejects.toThrow("old_string not found");
        });

        it("should fail when old_string and new_string are identical", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            await expect(
                editTool.execute({
                    path: "test.txt",
                    old_string: "World",
                    new_string: "World",
                })
            ).rejects.toThrow("old_string and new_string must be different");
        });

        it("should reject paths outside project directory", async () => {
            await expect(
                editTool.execute({
                    path: "../../../etc/passwd",
                    old_string: "old",
                    new_string: "new",
                })
            ).rejects.toThrow("Path outside project directory");
        });

        it("should fail when file does not exist", async () => {
            await expect(
                editTool.execute({
                    path: "nonexistent.txt",
                    old_string: "old",
                    new_string: "new",
                })
            ).rejects.toThrow();
        });
    });

    describe("edge cases", () => {
        it("should handle empty string replacement", async () => {
            const filePath = path.join(testDir, "test.txt");
            writeFileSync(filePath, "Hello, World!", "utf-8");

            const result = await editTool.execute({
                path: "test.txt",
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
                path: "unicode.txt",
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
                path: "subdir/nested.txt",
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
});
