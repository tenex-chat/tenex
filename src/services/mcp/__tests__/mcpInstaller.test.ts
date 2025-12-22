import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
    installMCPServerFromEvent,
    isMCPToolInstalled,
    getInstalledMCPEventIds,
    removeMCPServerByEventId,
} from "../mcpInstaller";
import { config } from "@/services/ConfigService";
import type { TenexMCP } from "@/services/config/types";
import * as fs from "node:fs";
import * as path from "node:path";
import { NDKMCPTool } from "@/events/NDKMCPTool";

describe("mcpInstaller", () => {
    const testMetadataPath = "/tmp/test-metadata-path";
    const wrongProjectPath = "/tmp/wrong-project-path";

    // Mock MCP tool
    const createMockMCPTool = (overrides: Partial<{ id: string; slug: string; command: string | undefined; description: string }> = {}) => {
        const tool = {
            id: "id" in overrides ? overrides.id : "event123",
            slug: "slug" in overrides ? overrides.slug : "test-server",
            command: "command" in overrides ? overrides.command : "npx test-server",
            description: "description" in overrides ? overrides.description : "Test MCP server",
        };
        return tool as unknown as NDKMCPTool;
    };

    beforeEach(async () => {
        // Clean up test directories
        await fs.promises.rm(testMetadataPath, { recursive: true, force: true });
        await fs.promises.rm(wrongProjectPath, { recursive: true, force: true });

        // Create test metadata directory
        await fs.promises.mkdir(testMetadataPath, { recursive: true });

        // Clear config cache
        config.clearCache();
    });

    afterEach(async () => {
        await fs.promises.rm(testMetadataPath, { recursive: true, force: true });
        await fs.promises.rm(wrongProjectPath, { recursive: true, force: true });
    });

    describe("installMCPServerFromEvent", () => {
        it("writes mcp.json to metadataPath, not to projectPath/.tenex", async () => {
            const mcpTool = createMockMCPTool();

            await installMCPServerFromEvent(testMetadataPath, mcpTool);

            // Should write to metadataPath/mcp.json
            const correctPath = path.join(testMetadataPath, "mcp.json");
            const wrongPath = path.join(wrongProjectPath, ".tenex", "mcp.json");

            expect(fs.existsSync(correctPath)).toBe(true);
            expect(fs.existsSync(wrongPath)).toBe(false);

            // Verify content
            const content = JSON.parse(await fs.promises.readFile(correctPath, "utf-8"));
            expect(content.servers["test-server"]).toBeDefined();
            expect(content.servers["test-server"].command).toBe("npx");
            expect(content.servers["test-server"].args).toEqual(["test-server"]);
        });

        it("throws error when command is missing", async () => {
            const mcpTool = createMockMCPTool({ command: undefined as unknown as string });

            await expect(installMCPServerFromEvent(testMetadataPath, mcpTool)).rejects.toThrow(
                /missing command/i
            );
        });

        it("skips installation if event ID already installed", async () => {
            const mcpTool = createMockMCPTool();

            // Install once
            await installMCPServerFromEvent(testMetadataPath, mcpTool);

            // Get initial content
            const correctPath = path.join(testMetadataPath, "mcp.json");
            const initialContent = await fs.promises.readFile(correctPath, "utf-8");

            // Install again with same event ID
            await installMCPServerFromEvent(testMetadataPath, mcpTool);

            // Content should be unchanged
            const finalContent = await fs.promises.readFile(correctPath, "utf-8");
            expect(finalContent).toBe(initialContent);
        });
    });

    describe("isMCPToolInstalled", () => {
        it("reads from metadataPath directly", async () => {
            // Pre-install a tool
            const mcpTool = createMockMCPTool({ id: "installed-event-id" });
            await installMCPServerFromEvent(testMetadataPath, mcpTool);

            // Check if installed - should use metadataPath directly
            const isInstalled = await isMCPToolInstalled(testMetadataPath, "installed-event-id");
            expect(isInstalled).toBe(true);

            // Non-existent event ID
            const notInstalled = await isMCPToolInstalled(testMetadataPath, "non-existent");
            expect(notInstalled).toBe(false);
        });

        it("returns false when no mcp.json exists", async () => {
            const emptyPath = "/tmp/empty-metadata-path";
            await fs.promises.mkdir(emptyPath, { recursive: true });

            const isInstalled = await isMCPToolInstalled(emptyPath, "any-event-id");
            expect(isInstalled).toBe(false);

            await fs.promises.rm(emptyPath, { recursive: true, force: true });
        });
    });

    describe("getInstalledMCPEventIds", () => {
        it("reads event IDs from metadataPath directly", async () => {
            // Install multiple tools
            await installMCPServerFromEvent(testMetadataPath, createMockMCPTool({ id: "event-1", slug: "server-1" }));
            await installMCPServerFromEvent(testMetadataPath, createMockMCPTool({ id: "event-2", slug: "server-2" }));

            const eventIds = await getInstalledMCPEventIds(testMetadataPath);

            expect(eventIds.has("event-1")).toBe(true);
            expect(eventIds.has("event-2")).toBe(true);
            expect(eventIds.size).toBe(2);
        });

        it("returns empty set when no mcp.json exists", async () => {
            const emptyPath = "/tmp/empty-metadata-path-2";
            await fs.promises.mkdir(emptyPath, { recursive: true });

            const eventIds = await getInstalledMCPEventIds(emptyPath);
            expect(eventIds.size).toBe(0);

            await fs.promises.rm(emptyPath, { recursive: true, force: true });
        });
    });

    describe("removeMCPServerByEventId", () => {
        it("removes server from metadataPath directly", async () => {
            // Install a tool
            const mcpTool = createMockMCPTool({ id: "to-remove", slug: "removable-server" });
            await installMCPServerFromEvent(testMetadataPath, mcpTool);

            // Verify it's installed
            expect(await isMCPToolInstalled(testMetadataPath, "to-remove")).toBe(true);

            // Remove it
            await removeMCPServerByEventId(testMetadataPath, "to-remove");

            // Verify it's gone
            expect(await isMCPToolInstalled(testMetadataPath, "to-remove")).toBe(false);
        });

        it("does nothing when event ID not found", async () => {
            // Install a tool
            await installMCPServerFromEvent(testMetadataPath, createMockMCPTool({ id: "keeper", slug: "keep-server" }));

            // Try to remove non-existent
            await removeMCPServerByEventId(testMetadataPath, "non-existent");

            // Original should still be there
            expect(await isMCPToolInstalled(testMetadataPath, "keeper")).toBe(true);
        });
    });
});
