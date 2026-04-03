import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as agentHome from "@/lib/agent-home";
import type { InjectedFile } from "@/lib/agent-home";
import {
    agentHomeDirectoryFragment,
    clearAgentHomePromptCache,
    getAgentHomeDirectory,
} from "../02-agent-home-directory";

// Mock the logger to avoid console output during tests
mock.module("@/utils/logger", () => ({
    logger: {
        warn: () => {},
        info: () => {},
        error: () => {},
        debug: () => {},
    },
}));

describe("agent-home-directory fragment", () => {
    const mockAgent = {
        pubkey: "abcd1234567890ef",
        slug: "test-agent",
        name: "Test Agent",
        role: "test",
        signer: {
            nsec: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq26us3r",
        },
    };

    describe("getAgentHomeDirectory", () => {
        it("should return path with first 8 characters of pubkey", () => {
            const result = getAgentHomeDirectory("abcd1234567890ef");
            expect(result).toContain("/home/abcd1234");
            expect(result).not.toContain("567890ef");
        });

        it("should handle short pubkeys gracefully", () => {
            const result = getAgentHomeDirectory("abc");
            expect(result).toContain("/home/abc");
        });
    });

    describe("agentHomeDirectoryFragment.template", () => {
        let ensureAgentHomeSpy: ReturnType<typeof spyOn>;
        let readdirSyncSpy: ReturnType<typeof spyOn>;
        let getInjectedFilesSpy: ReturnType<typeof spyOn>;
        let getProjectInjectedFilesSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            clearAgentHomePromptCache();
            // Reset spies before each test
            ensureAgentHomeSpy = spyOn(agentHome, "ensureAgentHomeDirectory");
            readdirSyncSpy = spyOn(fs, "readdirSync");
            getInjectedFilesSpy = spyOn(agentHome, "getAgentHomeInjectedFiles");
            getProjectInjectedFilesSpy = spyOn(agentHome, "getAgentProjectInjectedFiles");
            // Default to no injected files
            getInjectedFilesSpy.mockImplementation(() => []);
            getProjectInjectedFilesSpy.mockImplementation(() => []);
        });

        afterEach(() => {
            clearAgentHomePromptCache();
            ensureAgentHomeSpy.mockRestore();
            readdirSyncSpy.mockRestore();
            getInjectedFilesSpy.mockRestore();
            getProjectInjectedFilesSpy.mockRestore();
        });

        it("should show empty directory message when no files exist", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("<home-directory>");
            expect(result).toContain("(empty)");
            expect(result).toContain("Use this space for notes, helper scripts, temporary files, or any personal workspace needs.");
        });

        it("should show file and directory counts instead of listing names", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => [
                { name: "notes.txt", isDirectory: () => false, isFile: () => true },
                { name: "scripts", isDirectory: () => true, isFile: () => false },
                { name: "data.json", isDirectory: () => false, isFile: () => true },
            ]);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("2 files, 1 directory");
        });

        it("should show correct count for many files", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            const manyEntries = Array.from({ length: 30 }, (_, i) => ({
                name: `file-${String(i).padStart(2, "0")}.txt`,
                isDirectory: () => false,
                isFile: () => true,
            }));
            readdirSyncSpy.mockImplementation(() => manyEntries);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("30 files");
            expect(result).not.toContain("file-00.txt");
        });

        it("should hide dotfiles from the count", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => [
                { name: ".env", isDirectory: () => false, isFile: () => true },
                { name: "notes.txt", isDirectory: () => false, isFile: () => true },
            ]);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("1 file");
        });

        it("should handle directory creation failure gracefully", async () => {
            ensureAgentHomeSpy.mockImplementation(() => false);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("(home directory unavailable)");
            expect(result).toContain("<home-directory>");
        });

        it("should handle directory listing failure gracefully", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => {
                throw new Error("Cannot read directory");
            });

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("(unable to read directory)");
            expect(result).toContain("<home-directory>");
        });

        it("should include the correct home directory path in output", async () => {
            // Use the same function that the template uses to ensure consistency
            const expectedPath = getAgentHomeDirectory(mockAgent.pubkey);
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            // Verify the path in the output matches what getAgentHomeDirectory returns
            expect(result).toContain(expectedPath);
            // Also verify it contains the expected pubkey prefix
            expect(result).toContain("/home/abcd1234");
        });

        it("should count files and directories separately", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => [
                { name: "zebra.txt", isDirectory: () => false, isFile: () => true },
                { name: "alpha.txt", isDirectory: () => false, isFile: () => true },
                { name: "beta", isDirectory: () => true, isFile: () => false },
            ]);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("2 files, 1 directory");
        });

        it("should include documentation about auto-injected files", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("Shell env files:");
            expect(result).toContain("precedence `agent > project > global`");
            expect(result).toContain("Your nsec is in your home directory's `.env` file as `NSEC`");
            expect(result).toContain("`.env` contents are NOT injected into your prompt");
            expect(result).toContain("Auto-injected files:");
            expect(result).toContain("Files starting with `+`");
            expect(result).toContain("critical reminders");
        });

        it("should inject +prefixed file contents when present", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => [
                { name: "+NOTES.md", isDirectory: () => false, isFile: () => true },
            ]);
            const injectedFiles: InjectedFile[] = [
                { filename: "+NOTES.md", content: "Remember to test everything!", truncated: false },
            ];
            getInjectedFilesSpy.mockImplementation(() => injectedFiles);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("<memorized-files>");
            expect(result).toContain(`<file name="+NOTES.md">`);
            expect(result).toContain("Remember to test everything!");
        });

        it("should show truncation warning for truncated files", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => []);
            const injectedFiles: InjectedFile[] = [
                { filename: "+LONG.txt", content: "x".repeat(1500), truncated: true },
            ];
            getInjectedFilesSpy.mockImplementation(() => injectedFiles);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain(`<file name="+LONG.txt" truncated="true">`);
            expect(result).toContain("x".repeat(1500));
        });

        it("should inject multiple +prefixed files", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => []);
            const injectedFiles: InjectedFile[] = [
                { filename: "+ALPHA.txt", content: "First file", truncated: false },
                { filename: "+BETA.txt", content: "Second file", truncated: false },
            ];
            getInjectedFilesSpy.mockImplementation(() => injectedFiles);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain(`<file name="+ALPHA.txt">`);
            expect(result).toContain("First file");
            expect(result).toContain(`<file name="+BETA.txt">`);
            expect(result).toContain("Second file");
        });

        it("should not show injected files section when no +prefixed files exist", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => [
                { name: "regular.txt", isDirectory: () => false },
            ]);
            getInjectedFilesSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).not.toContain("<memorized-files>");
        });

        it("should document project-specific memory when project context is present", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({
                agent: mockAgent,
                projectId: "acme-app",
            } as never);

            expect(result).toContain("/home/abcd1234/projects/acme-app/docs");
            expect(result).toContain("injected in the project-context section");
        });

        it("should inject home-scoped +files only (project files moved to project-context)", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => []);
            getInjectedFilesSpy.mockImplementation(() => [
                { filename: "+HOME.md", content: "Home memory", truncated: false },
            ]);
            getProjectInjectedFilesSpy.mockImplementation(() => [
                { filename: "+PROJECT.md", content: "Project memory", truncated: false },
            ]);

            const result = await agentHomeDirectoryFragment.template({
                agent: mockAgent,
                projectId: "acme-app",
            } as never);

            expect(result).toContain("<memorized-files>");
            expect(result).toContain("Home memory");
            // Project files are now in project-context fragment, not here
            expect(result).not.toContain("<memorized-project-files>");
            expect(result).not.toContain("Project memory");
        });

        it("should reflect updated injected files and count on consecutive renders", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy
                .mockImplementationOnce(() => [
                    { name: "+NOTES.md", isDirectory: () => false, isFile: () => true },
                ])
                .mockImplementationOnce(() => [
                    { name: "+NOTES.md", isDirectory: () => false, isFile: () => true },
                    { name: "fresh.txt", isDirectory: () => false, isFile: () => true },
                ]);
            getInjectedFilesSpy
                .mockImplementationOnce(() => [
                    { filename: "+NOTES.md", content: "Old note", truncated: false },
                ])
                .mockImplementationOnce(() => [
                    { filename: "+NOTES.md", content: "Updated note", truncated: false },
                ]);

            const firstRender = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);
            const secondRender = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(firstRender).toContain("Old note");
            expect(firstRender).toContain("1 file");
            expect(secondRender).toContain("Updated note");
            expect(secondRender).toContain("2 files");
        });
    });

    describe("fragment metadata", () => {
        it("should have correct id", () => {
            expect(agentHomeDirectoryFragment.id).toBe("agent-home-directory");
        });

        it("should have priority 2 (after agent-identity)", () => {
            expect(agentHomeDirectoryFragment.priority).toBe(2);
        });
    });
});
