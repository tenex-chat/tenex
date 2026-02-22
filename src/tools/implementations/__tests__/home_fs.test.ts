import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import type { ToolExecutionContext } from "@/tools/types";
import {
    createHomeFsGrepTool,
    createHomeFsReadTool,
    createHomeFsWriteTool,
} from "../home_fs";

// Mock the logger to avoid console output during tests
mock.module("@/utils/logger", () => ({
    logger: {
        warn: () => {},
        info: () => {},
        error: () => {},
        debug: () => {},
    },
}));

// Mock constants to use a test-specific base path
const TEST_BASE_PATH = "/tmp/tenex-home-fs-test";
mock.module("@/constants", () => ({
    getTenexBasePath: () => TEST_BASE_PATH,
}));

describe("home_fs tools", () => {
    const testPubkey = "homefs12345678";
    let homeDir: string;

    // Create a minimal mock context
    const createMockContext = (): ToolExecutionContext =>
        ({
            agent: {
                pubkey: testPubkey,
                name: "Test Agent",
                slug: "test-agent",
            },
            workingDirectory: "/some/project/dir",
            projectBasePath: "/some/project/dir",
            conversationId: "test-conversation-123",
        }) as unknown as ToolExecutionContext;

    beforeEach(() => {
        // Create test home directory
        homeDir = getAgentHomeDirectory(testPubkey);
        mkdirSync(homeDir, { recursive: true });
    });

    afterEach(() => {
        // Cleanup test home directory
        try {
            rmSync(homeDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe("home_fs_read", () => {
        it("should read a file in home directory using relative path", async () => {
            writeFileSync(join(homeDir, "notes.txt"), "Hello, World!");

            const tool = createHomeFsReadTool(createMockContext());
            const result = await tool.execute({
                path: "notes.txt",
                description: "Reading notes",
            });

            expect(result).toContain("Hello, World!");
        });

        it("should read a file using absolute path within home", async () => {
            writeFileSync(join(homeDir, "data.txt"), "Data content");

            const tool = createHomeFsReadTool(createMockContext());
            const absolutePath = join(homeDir, "data.txt");
            const result = await tool.execute({
                path: absolutePath,
                description: "Reading data",
            });

            expect(result).toContain("Data content");
        });

        it("should list directory contents", async () => {
            writeFileSync(join(homeDir, "file1.txt"), "content1");
            writeFileSync(join(homeDir, "file2.txt"), "content2");

            const tool = createHomeFsReadTool(createMockContext());
            const result = await tool.execute({
                path: ".",
                description: "Listing home",
            });

            expect(result).toContain("file1.txt");
            expect(result).toContain("file2.txt");
        });

        it("should reject paths outside home directory", async () => {
            const tool = createHomeFsReadTool(createMockContext());
            const result = await tool.execute({
                path: "/etc/passwd",
                description: "Trying to read outside home",
            });

            // Expected error results are { type: "error-text", text: "..." }
            expect(result).toEqual(
                expect.objectContaining({
                    type: "error-text",
                    text: expect.stringContaining("outside your home directory"),
                })
            );
        });

        it("should reject path traversal attempts", async () => {
            const tool = createHomeFsReadTool(createMockContext());
            const result = await tool.execute({
                path: "../other-agent/file.txt",
                description: "Trying path traversal",
            });

            expect(result).toEqual(
                expect.objectContaining({
                    type: "error-text",
                    text: expect.stringContaining("outside your home directory"),
                })
            );
        });

        it("should handle non-existent files gracefully", async () => {
            const tool = createHomeFsReadTool(createMockContext());
            const result = await tool.execute({
                path: "nonexistent.txt",
                description: "Reading missing file",
            });

            expect(result).toEqual(
                expect.objectContaining({
                    type: "error-text",
                    text: expect.stringContaining("not found"),
                })
            );
        });

        it("should support pagination with offset and limit", async () => {
            const content = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n");
            writeFileSync(join(homeDir, "long.txt"), content);

            const tool = createHomeFsReadTool(createMockContext());
            const result = await tool.execute({
                path: "long.txt",
                description: "Reading paginated",
                offset: 10,
                limit: 5,
            });

            expect(result).toContain("Line 10");
            expect(result).toContain("Line 14");
            expect(result).not.toContain("Line 1\t"); // Line 1 should not be there
            expect(result).not.toContain("Line 20");
        });

        it("should have correct human-readable content", () => {
            const tool = createHomeFsReadTool(createMockContext());
            const getHumanReadable = (tool as { getHumanReadableContent?: (args: unknown) => string })
                .getHumanReadableContent;
            expect(getHumanReadable).toBeDefined();

            const humanContent = getHumanReadable!({
                path: "notes.txt",
                description: "checking notes",
            });
            expect(humanContent).toBe("Reading notes.txt (checking notes)");
        });
    });

    describe("home_fs_write", () => {
        it("should write a file in home directory using relative path", async () => {
            const tool = createHomeFsWriteTool(createMockContext());
            const result = await tool.execute({
                path: "new-file.txt",
                content: "New content here",
            });

            expect(result).toContain("Successfully wrote");
            expect(result).toContain("16 bytes");

            // Verify file was created
            const { readFileSync } = await import("node:fs");
            const written = readFileSync(join(homeDir, "new-file.txt"), "utf-8");
            expect(written).toBe("New content here");
        });

        it("should create parent directories automatically", async () => {
            const tool = createHomeFsWriteTool(createMockContext());
            const result = await tool.execute({
                path: "subdir/nested/file.txt",
                content: "Nested content",
            });

            expect(result).toContain("Successfully wrote");

            const { readFileSync } = await import("node:fs");
            const written = readFileSync(join(homeDir, "subdir/nested/file.txt"), "utf-8");
            expect(written).toBe("Nested content");
        });

        it("should reject writes outside home directory", async () => {
            const tool = createHomeFsWriteTool(createMockContext());
            const result = await tool.execute({
                path: "/tmp/outside-home.txt",
                content: "Should not write",
            });

            expect(result).toEqual(
                expect.objectContaining({
                    type: "error-text",
                    text: expect.stringContaining("outside your home directory"),
                })
            );
        });

        it("should reject path traversal attempts", async () => {
            const tool = createHomeFsWriteTool(createMockContext());
            const result = await tool.execute({
                path: "../other-agent/file.txt",
                content: "Trying to escape",
            });

            expect(result).toEqual(
                expect.objectContaining({
                    type: "error-text",
                    text: expect.stringContaining("outside your home directory"),
                })
            );
        });

        it("should overwrite existing files", async () => {
            writeFileSync(join(homeDir, "existing.txt"), "Original content");

            const tool = createHomeFsWriteTool(createMockContext());
            const result = await tool.execute({
                path: "existing.txt",
                content: "Updated content",
            });

            expect(result).toContain("Successfully wrote");

            const { readFileSync } = await import("node:fs");
            const written = readFileSync(join(homeDir, "existing.txt"), "utf-8");
            expect(written).toBe("Updated content");
        });

        it("should have correct human-readable content", () => {
            const tool = createHomeFsWriteTool(createMockContext());
            const getHumanReadable = (tool as { getHumanReadableContent?: (args: unknown) => string })
                .getHumanReadableContent;
            expect(getHumanReadable).toBeDefined();

            const humanContent = getHumanReadable!({ path: "notes.txt", content: "stuff", description: "saving notes" });
            expect(humanContent).toBe("Writing notes.txt (saving notes)");
        });
    });

    describe("home_fs_grep", () => {
        beforeEach(() => {
            // Create some test files for searching
            writeFileSync(join(homeDir, "file1.txt"), "Hello World\nGoodbye World");
            writeFileSync(join(homeDir, "file2.txt"), "Hello There\nHello Again");
            mkdirSync(join(homeDir, "subdir"), { recursive: true });
            writeFileSync(join(homeDir, "subdir", "file3.txt"), "Hello Nested");
        });

        it("should search for patterns in home directory", async () => {
            const tool = createHomeFsGrepTool(createMockContext());
            const result = await tool.execute({
                pattern: "Hello",
                output_mode: "files_with_matches",
            });

            expect(result).toContain("file1.txt");
            expect(result).toContain("file2.txt");
            expect(result).toContain("subdir/file3.txt");
        });

        it("should search with content mode", async () => {
            const tool = createHomeFsGrepTool(createMockContext());
            const result = await tool.execute({
                pattern: "World",
                output_mode: "content",
            });

            expect(result).toContain("Hello World");
            expect(result).toContain("Goodbye World");
        });

        it("should support case-insensitive search", async () => {
            const tool = createHomeFsGrepTool(createMockContext());
            const result = await tool.execute({
                pattern: "hello",
                "-i": true,
                output_mode: "files_with_matches",
            });

            expect(result).toContain("file1.txt");
            expect(result).toContain("file2.txt");
        });

        it("should search within a subdirectory", async () => {
            const tool = createHomeFsGrepTool(createMockContext());
            const result = await tool.execute({
                pattern: "Hello",
                path: "subdir",
                output_mode: "files_with_matches",
            });

            expect(result).toContain("file3.txt");
            expect(result).not.toContain("file1.txt");
        });

        it("should reject search paths outside home directory", async () => {
            const tool = createHomeFsGrepTool(createMockContext());
            const result = await tool.execute({
                pattern: "root",
                path: "/etc",
            });

            expect(result).toEqual(
                expect.objectContaining({
                    type: "error-text",
                    text: expect.stringContaining("outside your home directory"),
                })
            );
        });

        it("should return no matches message when nothing found", async () => {
            const tool = createHomeFsGrepTool(createMockContext());
            const result = await tool.execute({
                pattern: "xyz-nonexistent-pattern",
            });

            expect(result).toContain("No matches found");
        });

        it("should respect head_limit", async () => {
            // Create many files with matches
            for (let i = 0; i < 20; i++) {
                writeFileSync(join(homeDir, `match-${String(i).padStart(2, "0")}.txt`), "pattern");
            }

            const tool = createHomeFsGrepTool(createMockContext());
            const result = await tool.execute({
                pattern: "pattern",
                output_mode: "files_with_matches",
                head_limit: 5,
            });

            // Should be truncated
            expect(result).toContain("Truncated");
            expect(result).toContain("showing 5");
        });

        it("should have correct human-readable content", () => {
            const tool = createHomeFsGrepTool(createMockContext());
            const getHumanReadable = (tool as { getHumanReadableContent?: (args: unknown) => string })
                .getHumanReadableContent;
            expect(getHumanReadable).toBeDefined();

            const humanContent = getHumanReadable!({ pattern: "TODO", path: "notes", description: "find pending items" });
            expect(humanContent).toBe("Searching for 'TODO' in notes (find pending items)");

            const humanContentNoPath = getHumanReadable!({ pattern: "TODO", description: "find pending items" });
            expect(humanContentNoPath).toBe("Searching for 'TODO' in home (find pending items)");
        });

        it("should safely handle patterns with shell metacharacters", async () => {
            // Create a file with special content
            writeFileSync(join(homeDir, "shell-test.txt"), "test'quote and $VAR content");

            const tool = createHomeFsGrepTool(createMockContext());

            // Pattern with single quotes (potential shell injection)
            const result = await tool.execute({
                pattern: "test'quote",
                output_mode: "content",
            });

            // Should find the match without shell injection issues
            expect(result).toContain("test'quote");
        });

        it("should safely handle paths with shell metacharacters", async () => {
            // Create a subdirectory with quotes in the name
            const specialDir = join(homeDir, "dir'with'quotes");
            mkdirSync(specialDir, { recursive: true });
            writeFileSync(join(specialDir, "file.txt"), "content in special dir");

            const tool = createHomeFsGrepTool(createMockContext());

            // Search in directory with shell metacharacters in path
            const result = await tool.execute({
                pattern: "content",
                path: "dir'with'quotes",
                output_mode: "files_with_matches",
            });

            // Should work without shell injection
            expect(result).toContain("file.txt");
        });
    });

    describe("tool descriptions", () => {
        it("home_fs_read description mentions home-only restriction", () => {
            const tool = createHomeFsReadTool(createMockContext());
            const description = (tool as { description?: string }).description || "";
            expect(description).toContain("ONLY operates within your home directory");
            expect(description).toContain("cannot access files outside your home");
        });

        it("home_fs_write description mentions home-only restriction", () => {
            const tool = createHomeFsWriteTool(createMockContext());
            const description = (tool as { description?: string }).description || "";
            expect(description).toContain("ONLY operates within your home directory");
            expect(description).toContain("cannot write files outside your home");
        });

        it("home_fs_grep description mentions home-only restriction", () => {
            const tool = createHomeFsGrepTool(createMockContext());
            const description = (tool as { description?: string }).description || "";
            expect(description).toContain("ONLY operates within your home directory");
            expect(description).toContain("cannot search files outside your home");
        });
    });
});
