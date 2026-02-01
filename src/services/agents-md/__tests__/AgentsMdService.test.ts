import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentsMdService } from "../AgentsMdService";

describe("AgentsMdService", () => {
    let testDir: string;

    beforeEach(() => {
        // Create a unique test directory
        testDir = join(tmpdir(), `agents-md-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });

        // Clear the cache before each test
        agentsMdService.clearCache();
    });

    afterEach(() => {
        // Clean up test directory
        rmSync(testDir, { recursive: true, force: true });
    });

    describe("findAgentsMdFiles", () => {
        it("should find AGENTS.md at project root", async () => {
            const content = "# Root Guidelines";
            writeFileSync(join(testDir, "AGENTS.md"), content);

            const files = await agentsMdService.findAgentsMdFiles(
                join(testDir, "src/file.ts"),
                testDir
            );

            expect(files).toHaveLength(1);
            expect(files[0].content).toBe(content);
            expect(files[0].directory).toBe(testDir);
        });

        it("should find multiple AGENTS.md files hierarchically", async () => {
            // Create directory structure
            mkdirSync(join(testDir, "src", "components"), { recursive: true });

            // Create AGENTS.md files at different levels
            writeFileSync(join(testDir, "AGENTS.md"), "# Root");
            writeFileSync(join(testDir, "src", "AGENTS.md"), "# Src");
            writeFileSync(join(testDir, "src", "components", "AGENTS.md"), "# Components");

            const files = await agentsMdService.findAgentsMdFiles(
                join(testDir, "src/components/Button.tsx"),
                testDir
            );

            // Should find all three, most specific first
            expect(files).toHaveLength(3);
            expect(files[0].content).toBe("# Components");
            expect(files[1].content).toBe("# Src");
            expect(files[2].content).toBe("# Root");
        });

        it("should return empty array when no AGENTS.md exists", async () => {
            const files = await agentsMdService.findAgentsMdFiles(
                join(testDir, "src/file.ts"),
                testDir
            );

            expect(files).toHaveLength(0);
        });

        it("should not search beyond project root", async () => {
            // Create AGENTS.md in parent directory (outside project)
            const parentDir = join(testDir, "..");
            writeFileSync(join(parentDir, "AGENTS.md"), "# Parent");

            const subProject = join(testDir, "subproject");
            mkdirSync(subProject, { recursive: true });

            const files = await agentsMdService.findAgentsMdFiles(
                join(subProject, "file.ts"),
                subProject
            );

            // Should not find the parent AGENTS.md
            expect(files).toHaveLength(0);
        });

        it("should cache file contents", async () => {
            const content = "# Cached Content";
            writeFileSync(join(testDir, "AGENTS.md"), content);

            // First call
            const files1 = await agentsMdService.findAgentsMdFiles(
                join(testDir, "file.ts"),
                testDir
            );

            // Modify the file (but cache should still have old content)
            writeFileSync(join(testDir, "AGENTS.md"), "# Modified");

            // Second call should use cache
            const files2 = await agentsMdService.findAgentsMdFiles(
                join(testDir, "other-file.ts"),
                testDir
            );

            expect(files1[0].content).toBe(content);
            expect(files2[0].content).toBe(content); // Still cached
        });
    });

    describe("hasRootAgentsMd", () => {
        it("should return true when AGENTS.md exists at root", async () => {
            writeFileSync(join(testDir, "AGENTS.md"), "# Root");

            const result = await agentsMdService.hasRootAgentsMd(testDir);
            expect(result).toBe(true);
        });

        it("should return false when AGENTS.md does not exist at root", async () => {
            const result = await agentsMdService.hasRootAgentsMd(testDir);
            expect(result).toBe(false);
        });
    });

    describe("getRootAgentsMdContent", () => {
        it("should return content when AGENTS.md exists", async () => {
            const content = "# Root Guidelines\n\nSome content here.";
            writeFileSync(join(testDir, "AGENTS.md"), content);

            const result = await agentsMdService.getRootAgentsMdContent(testDir);
            expect(result).toBe(content);
        });

        it("should return null when AGENTS.md does not exist", async () => {
            const result = await agentsMdService.getRootAgentsMdContent(testDir);
            expect(result).toBeNull();
        });
    });
});
