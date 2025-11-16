import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { ProjectRuntime } from "../ProjectRuntime";

describe("ProjectRuntime.start()", () => {
    let tempDir: string;
    let projectsBase: string;

    beforeEach(async () => {
        // Create a temporary directory for testing
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-test-"));
        projectsBase = path.join(tempDir, "projects");
        await fs.mkdir(projectsBase, { recursive: true });
    });

    afterEach(async () => {
        // Clean up temp directory
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test("should start successfully with valid project", async () => {
        // Create a mock NDKProject
        const mockProject = {
            kind: 31933,
            pubkey: "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7",
            tags: [
                ["d", "test-project"],
                ["title", "Test Project"],
                ["agent", "test-agent-pubkey"],
            ],
            tagValue: (tagName: string) => {
                const tag = mockProject.tags.find((t) => t[0] === tagName);
                return tag ? tag[1] : undefined;
            },
            repo: undefined,
        } as unknown as NDKProject;

        // Create ProjectRuntime
        const runtime = new ProjectRuntime(mockProject, projectsBase);

        // This should reproduce the "paths[0] must be of type string, got undefined" error
        await runtime.start();

        // If we get here, the error is fixed
        expect(true).toBe(true);
    });

    test("should fail with undefined in allowedPaths", async () => {
        // First, set up MCP config with undefined in allowedPaths
        const configService = await import("@/services/ConfigService");
        const originalLoadConfig = configService.configService.loadConfig.bind(
            configService.configService
        );

        // Mock loadConfig to return MCP config with undefined in allowedPaths
        configService.configService.loadConfig = async () => {
            const result = await originalLoadConfig();
            result.mcp = {
                enabled: true,
                servers: {
                    "test-server": {
                        command: "echo",
                        args: ["test"],
                        allowedPaths: [undefined as any, "/some/path"], // undefined in array!
                    },
                },
            };
            return result;
        };

        const mockProject = {
            kind: 31933,
            pubkey: "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7",
            tags: [
                ["d", "test-mcp-project"],
                ["title", "Test MCP Project"],
                ["mcp", "some-mcp-event-id"],
            ],
            tagValue: (tagName: string) => {
                const tag = mockProject.tags.find((t) => t[0] === tagName);
                return tag ? tag[1] : undefined;
            },
            repo: undefined,
        } as unknown as NDKProject;

        const runtime = new ProjectRuntime(mockProject, projectsBase);

        // This should throw the "paths[0] must be of type string, got undefined" error
        await expect(runtime.start()).rejects.toThrow(/paths\[0\]/);

        // Restore original
        configService.configService.loadConfig = originalLoadConfig;
    });
});
