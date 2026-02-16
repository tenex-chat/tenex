import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { MCPManager } from "../MCPManager";
import { config as configService } from "@/services/ConfigService";
import type { TenexMCP } from "@/services/config/types";

describe("MCPManager per-project isolation", () => {
    let loadTenexMCPSpy: ReturnType<typeof spyOn>;
    let getGlobalPathSpy: ReturnType<typeof spyOn>;

    // Mock MCP configs for different projects
    const globalMCP: TenexMCP = { servers: {}, enabled: true };
    const project1MCP: TenexMCP = {
        servers: {
            "project1-server": {
                command: "npx",
                args: ["project1-mcp"],
            },
        },
        enabled: true,
    };
    const project2MCP: TenexMCP = {
        servers: {
            "project2-server": {
                command: "npx",
                args: ["project2-mcp"],
            },
        },
        enabled: true,
    };

    beforeEach(() => {
        getGlobalPathSpy = spyOn(configService, "getGlobalPath").mockReturnValue("/global");
        loadTenexMCPSpy = spyOn(configService, "loadTenexMCP").mockImplementation(
            async (path: string) => {
                if (path === "/global") return globalMCP;
                if (path === "/project1") return project1MCP;
                if (path === "/project2") return project2MCP;
                return { servers: {}, enabled: true };
            }
        );
    });

    afterEach(() => {
        loadTenexMCPSpy.mockRestore();
        getGlobalPathSpy.mockRestore();
    });

    it("should allow creating independent MCPManager instances for different projects", async () => {
        // Create two separate MCPManager instances (one per project)
        const manager1 = new MCPManager();
        const manager2 = new MCPManager();

        // Initialize each with different project configs
        await manager1.initialize("/project1", "/work/project1");
        await manager2.initialize("/project2", "/work/project2");

        // Each manager should have its own metadataPath
        // @ts-expect-error Accessing private field for testing
        expect(manager1.metadataPath).toBe("/project1");
        // @ts-expect-error Accessing private field for testing
        expect(manager2.metadataPath).toBe("/project2");

        // They should be independent - modifying one doesn't affect the other
        // @ts-expect-error Accessing private field for testing
        expect(manager1.metadataPath).not.toBe(manager2.metadataPath);
    });

    it("should maintain isolation when projects run concurrently", async () => {
        // Simulate two projects running at the same time
        const manager1 = new MCPManager();
        const manager2 = new MCPManager();

        // Both initialize concurrently
        await Promise.all([
            manager1.initialize("/project1", "/work/project1"),
            manager2.initialize("/project2", "/work/project2"),
        ]);

        // Each should maintain its own configuration
        // @ts-expect-error Accessing private field for testing
        expect(manager1.metadataPath).toBe("/project1");
        // @ts-expect-error Accessing private field for testing
        expect(manager2.metadataPath).toBe("/project2");

        // Verify they're truly separate instances
        expect(manager1).not.toBe(manager2);
    });

    it("should not share cached tools between project instances", async () => {
        const manager1 = new MCPManager();
        const manager2 = new MCPManager();

        await manager1.initialize("/project1", "/work/project1");
        await manager2.initialize("/project2", "/work/project2");

        // Get cached tools from each (they'll be empty since we're not starting real servers)
        const tools1 = manager1.getCachedTools();
        const tools2 = manager2.getCachedTools();

        // Verify they're separate objects (not the same reference)
        expect(tools1).not.toBe(tools2);
    });

    it("should return server configs via getServerConfigs()", async () => {
        const manager = new MCPManager();

        // Before initialization, should return empty object
        const configsBefore = manager.getServerConfigs();
        expect(Object.keys(configsBefore).length).toBe(0);

        // After initialization (with mocked config that won't start real servers)
        await manager.initialize("/project1", "/work/project1");

        // getServerConfigs should return configs from running servers
        // Since we're mocking and servers won't actually start, it should be empty
        const configsAfter = manager.getServerConfigs();
        expect(typeof configsAfter).toBe("object");
    });

    it("should return separate server configs for different instances", async () => {
        const manager1 = new MCPManager();
        const manager2 = new MCPManager();

        await manager1.initialize("/project1", "/work/project1");
        await manager2.initialize("/project2", "/work/project2");

        const configs1 = manager1.getServerConfigs();
        const configs2 = manager2.getServerConfigs();

        // Verify they're separate objects (not the same reference)
        expect(configs1).not.toBe(configs2);
    });
});
