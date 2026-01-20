import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as constants from "@/constants";
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
        let mkdirSyncSpy: ReturnType<typeof spyOn>;
        let readdirSyncSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            // Reset spies before each test
            mkdirSyncSpy = spyOn(fs, "mkdirSync");
            readdirSyncSpy = spyOn(fs, "readdirSync");
        });

        afterEach(() => {
            mkdirSyncSpy.mockRestore();
            readdirSyncSpy.mockRestore();
        });

        it("should show empty directory message when no files exist", async () => {
            mkdirSyncSpy.mockImplementation(() => undefined);
            readdirSyncSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("## Your Home Directory");
            expect(result).toContain("(empty)");
            expect(result).toContain("Feel free to use this space");
        });

        it("should list files and directories with proper formatting", async () => {
            mkdirSyncSpy.mockImplementation(() => undefined);
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
            mkdirSyncSpy.mockImplementation(() => undefined);
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
            mkdirSyncSpy.mockImplementation(() => {
                throw new Error("Permission denied");
            });

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("(home directory unavailable)");
            expect(result).toContain("## Your Home Directory");
        });

        it("should handle directory listing failure gracefully", async () => {
            mkdirSyncSpy.mockImplementation(() => undefined);
            readdirSyncSpy.mockImplementation(() => {
                throw new Error("Cannot read directory");
            });

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain("(unable to read directory)");
            expect(result).toContain("## Your Home Directory");
        });

        it("should include the correct home directory path in output", async () => {
            // Get the actual base path
            const basePath = constants.getTenexBasePath();
            mkdirSyncSpy.mockImplementation(() => undefined);
            readdirSyncSpy.mockImplementation(() => []);

            const result = await agentHomeDirectoryFragment.template({ agent: mockAgent } as never);

            expect(result).toContain(`${basePath}/home/abcd1234`);
        });

        it("should sort entries alphabetically", async () => {
            mkdirSyncSpy.mockImplementation(() => undefined);
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
