import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as agentHome from "@/lib/agent-home";
import type { InjectedFile } from "@/lib/agent-home";
import { agentHomeDirectoryFragment, getAgentHomeDirectory } from "../02-agent-home-directory";

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

        beforeEach(() => {
            // Reset spies before each test
            ensureAgentHomeSpy = spyOn(agentHome, "ensureAgentHomeDirectory");
            readdirSyncSpy = spyOn(fs, "readdirSync");
            getInjectedFilesSpy = spyOn(agentHome, "getAgentHomeInjectedFiles");
            // Default to no injected files
            getInjectedFilesSpy.mockImplementation(() => []);
        });

        afterEach(() => {
            ensureAgentHomeSpy.mockRestore();
            readdirSyncSpy.mockRestore();
            getInjectedFilesSpy.mockRestore();
        });

        it("should show empty directory message when no files exist", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("## Your Home Directory");
            expect(result).toContain("(empty)");
            expect(result).toContain("Feel free to use this space");
        });

        it("should list files and directories with proper formatting", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => [
                { name: "notes.txt", isDirectory: () => false },
                { name: "scripts", isDirectory: () => true },
                { name: "data.json", isDirectory: () => false },
            ]);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("data.json");
            expect(result).toContain("notes.txt");
            expect(result).toContain("scripts/");
        });

        it("should cap listing at 50 entries and show overflow count", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            // Create 60 mock entries
            const manyEntries = Array.from({ length: 60 }, (_, i) => ({
                name: `file-${String(i).padStart(2, "0")}.txt`,
                isDirectory: () => false,
            }));
            readdirSyncSpy.mockImplementation(() => manyEntries);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("...and 10 more");
            // Should have first 50 files
            expect(result).toContain("file-00.txt");
            expect(result).toContain("file-49.txt");
            // Should NOT have files beyond 50
            expect(result).not.toContain("file-50.txt");
        });

        it("should handle directory creation failure gracefully", async () => {
            ensureAgentHomeSpy.mockImplementation(() => false);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("(home directory unavailable)");
            expect(result).toContain("## Your Home Directory");
        });

        it("should handle directory listing failure gracefully", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => {
                throw new Error("Cannot read directory");
            });

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("(unable to read directory)");
            expect(result).toContain("## Your Home Directory");
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

        it("should sort entries alphabetically", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => [
                { name: "zebra.txt", isDirectory: () => false },
                { name: "alpha.txt", isDirectory: () => false },
                { name: "beta", isDirectory: () => true },
            ]);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            const alphaIndex = result.indexOf("alpha.txt");
            const betaIndex = result.indexOf("beta/");
            const zebraIndex = result.indexOf("zebra.txt");

            expect(alphaIndex).toBeLessThan(betaIndex);
            expect(betaIndex).toBeLessThan(zebraIndex);
        });

        it("should include documentation about auto-injected files", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

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

            expect(result).toContain("### Injected File Contents");
            expect(result).toContain("**+NOTES.md:**");
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

            expect(result).toContain("**+LONG.txt:**");
            expect(result).toContain("truncated to 1500 characters");
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

            expect(result).toContain("**+ALPHA.txt:**");
            expect(result).toContain("First file");
            expect(result).toContain("**+BETA.txt:**");
            expect(result).toContain("Second file");
        });

        it("should not show injected files section when no +prefixed files exist", async () => {
            ensureAgentHomeSpy.mockImplementation(() => true);
            readdirSyncSpy.mockImplementation(() => [
                { name: "regular.txt", isDirectory: () => false },
            ]);
            getInjectedFilesSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).not.toContain("### Injected File Contents");
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
