import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    createAgentsMdVisibilityTracker,
    formatSystemReminder,
    getSystemRemindersForPath,
    shouldInjectForTool,
    extractPathFromToolInput,
    appendSystemReminderToOutput,
} from "../SystemReminderInjector";
import { agentsMdService } from "../AgentsMdService";

describe("SystemReminderInjector", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = join(tmpdir(), `reminder-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
        agentsMdService.clearCache();
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    describe("createAgentsMdVisibilityTracker", () => {
        it("should track visible AGENTS.md paths", () => {
            const tracker = createAgentsMdVisibilityTracker();

            expect(tracker.isVisible("/path/AGENTS.md")).toBe(false);

            tracker.markVisible("/path/AGENTS.md");
            expect(tracker.isVisible("/path/AGENTS.md")).toBe(true);
        });

        it("should normalize paths when checking visibility", () => {
            const tracker = createAgentsMdVisibilityTracker();

            tracker.markVisible("/path/to/../AGENTS.md");
            expect(tracker.isVisible("/path/AGENTS.md")).toBe(true);
        });
    });

    describe("formatSystemReminder", () => {
        it("should format single AGENTS.md as system reminder", () => {
            const files = [
                {
                    path: join(testDir, "AGENTS.md"),
                    directory: testDir,
                    content: "# Root Guidelines",
                },
            ];

            const result = formatSystemReminder(files, testDir);

            expect(result).toContain("<system-reminder>");
            expect(result).toContain("</system-reminder>");
            expect(result).toContain("# AGENTS.md from (project root)");
            expect(result).toContain("# Root Guidelines");
        });

        it("should format multiple AGENTS.md files with relative paths", () => {
            const srcDir = join(testDir, "src");
            const files = [
                {
                    path: join(srcDir, "AGENTS.md"),
                    directory: srcDir,
                    content: "# Src Guidelines",
                },
                {
                    path: join(testDir, "AGENTS.md"),
                    directory: testDir,
                    content: "# Root Guidelines",
                },
            ];

            const result = formatSystemReminder(files, testDir);

            expect(result).toContain("# AGENTS.md from src");
            expect(result).toContain("# AGENTS.md from (project root)");
            expect(result).toContain("# Src Guidelines");
            expect(result).toContain("# Root Guidelines");
        });

        it("should return empty string for empty file list", () => {
            const result = formatSystemReminder([], testDir);
            expect(result).toBe("");
        });
    });

    describe("getSystemRemindersForPath", () => {
        it("should find and format AGENTS.md reminders", async () => {
            writeFileSync(join(testDir, "AGENTS.md"), "# Root Guidelines");

            const tracker = createAgentsMdVisibilityTracker();
            const result = await getSystemRemindersForPath(
                join(testDir, "file.ts"),
                testDir,
                tracker,
                false
            );

            expect(result.hasReminders).toBe(true);
            expect(result.content).toContain("<system-reminder>");
            expect(result.includedFiles).toHaveLength(1);
        });

        it("should not include already-visible files", async () => {
            writeFileSync(join(testDir, "AGENTS.md"), "# Root Guidelines");

            const tracker = createAgentsMdVisibilityTracker();
            tracker.markVisible(join(testDir, "AGENTS.md"));

            const result = await getSystemRemindersForPath(
                join(testDir, "file.ts"),
                testDir,
                tracker,
                false
            );

            expect(result.hasReminders).toBe(false);
            expect(result.content).toBe("");
            expect(result.includedFiles).toHaveLength(0);
        });

        it("should not mark as visible when truncated", async () => {
            writeFileSync(join(testDir, "AGENTS.md"), "# Root Guidelines");

            const tracker = createAgentsMdVisibilityTracker();
            const result = await getSystemRemindersForPath(
                join(testDir, "file.ts"),
                testDir,
                tracker,
                true // isTruncated = true
            );

            expect(result.hasReminders).toBe(true);
            // File should NOT be marked as visible since result is truncated
            expect(tracker.isVisible(join(testDir, "AGENTS.md"))).toBe(false);
        });
    });

    describe("shouldInjectForTool", () => {
        it("should return true for fs_read", () => {
            expect(shouldInjectForTool("fs_read")).toBe(true);
        });

        it("should return true for Read tool", () => {
            expect(shouldInjectForTool("Read")).toBe(true);
        });

        it("should return true for MCP filesystem tools", () => {
            expect(shouldInjectForTool("mcp__filesystem__read_file")).toBe(true);
            expect(shouldInjectForTool("mcp__filesystem__read_directory")).toBe(true);
        });

        it("should return false for non-file-read tools", () => {
            expect(shouldInjectForTool("fs_write")).toBe(false);
            expect(shouldInjectForTool("shell")).toBe(false);
            expect(shouldInjectForTool("delegate")).toBe(false);
        });
    });

    describe("extractPathFromToolInput", () => {
        it("should extract path parameter", () => {
            const result = extractPathFromToolInput("fs_read", { path: "/foo/bar.ts" });
            expect(result).toBe("/foo/bar.ts");
        });

        it("should extract file_path parameter", () => {
            const result = extractPathFromToolInput("Read", { file_path: "/foo/bar.ts" });
            expect(result).toBe("/foo/bar.ts");
        });

        it("should extract directory parameter", () => {
            const result = extractPathFromToolInput("list_dir", { directory: "/foo" });
            expect(result).toBe("/foo");
        });

        it("should return null for invalid input", () => {
            expect(extractPathFromToolInput("fs_read", null)).toBeNull();
            expect(extractPathFromToolInput("fs_read", "string")).toBeNull();
            expect(extractPathFromToolInput("fs_read", { other: "value" })).toBeNull();
        });
    });

    describe("appendSystemReminderToOutput", () => {
        it("should append to string output", () => {
            const result = appendSystemReminderToOutput(
                "File content here",
                "\n<system-reminder>AGENTS.md content</system-reminder>"
            );
            expect(result).toBe("File content here\n<system-reminder>AGENTS.md content</system-reminder>");
        });

        it("should append to object output with value property", () => {
            const result = appendSystemReminderToOutput(
                { type: "text", value: "File content" },
                "\n<reminder>"
            );
            expect(result).toEqual({
                type: "text",
                value: "File content\n<reminder>",
            });
        });
    });
});
