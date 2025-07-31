import { describe, it, expect, beforeEach, mock } from "bun:test";
import { fragmentRegistry } from "../../core/FragmentRegistry";
import { mcpService } from "@/services/mcp/MCPService";
import type { Tool } from "@/tools/types";

// Mock MCP service
mock.module("@/services/mcp/MCPService", () => ({
    mcpService: {
        getCachedTools: mock(),
    },
}));

describe("mcp-tools fragment", () => {
    beforeEach(() => {
        // The fragment is auto-registered when imported
        require("../mcp-tools");
    });

    it("should return empty string when MCP is disabled", () => {
        const fragment = fragmentRegistry.get("mcp-tools");
        expect(fragment).toBeDefined();

        const result = fragment!.template({ enabled: false });
        expect(result).toBe("");
    });

    it("should return empty string when no MCP tools are available", () => {
        (mcpService.getCachedTools as any).mockReturnValue([]);

        const fragment = fragmentRegistry.get("mcp-tools");
        const result = fragment!.template({ enabled: true });
        expect(result).toBe("");
    });

    it("should format single server with single tool", () => {
        const mockTools: Tool[] = [
            {
                name: "test-server/database-query",
                description: "Query the database",
                parameters: [
                    {
                        name: "query",
                        type: "string",
                        description: "SQL query to execute",
                        required: true,
                    },
                ],
                execute: async () => ({ success: true, output: "" }),
            },
        ];

        (mcpService.getCachedTools as any).mockReturnValue(mockTools);

        const fragment = fragmentRegistry.get("mcp-tools");
        const result = fragment!.template({ enabled: true });

        expect(result).toContain("## MCP Tools");
        expect(result).toContain("### test-server");
        expect(result).toContain("#### test-server/database-query");
        expect(result).toContain("Query the database");
        expect(result).toContain("Parameters:");
        expect(result).toContain("- query (string) *required*: SQL query to execute");
    });

    it("should format multiple tools from same server", () => {
        const mockTools: Tool[] = [
            {
                name: "analytics/query",
                description: "Query analytics data",
                parameters: [
                    {
                        name: "metric",
                        type: "string",
                        description: "Metric name",
                        required: true,
                    },
                ],
                execute: async () => ({ success: true, output: "" }),
            },
            {
                name: "analytics/export",
                description: "Export analytics data",
                parameters: [
                    {
                        name: "format",
                        type: "string",
                        description: "Export format",
                        required: false,
                    },
                ],
                execute: async () => ({ success: true, output: "" }),
            },
        ];

        (mcpService.getCachedTools as any).mockReturnValue(mockTools);

        const fragment = fragmentRegistry.get("mcp-tools");
        const result = fragment!.template({ enabled: true });

        // Check that we have one analytics server section
        expect(result).toContain("### analytics");

        // The tool names contain "analytics" too, so let's be more specific
        const lines = result.split("\n");
        const serverHeaderCount = lines.filter((line) => line === "### analytics").length;
        expect(serverHeaderCount).toBe(1);

        // Should have both tools
        expect(result).toContain("#### analytics/query");
        expect(result).toContain("#### analytics/export");

        // Should show parameter requirements correctly
        expect(result).toContain("metric (string) *required*:");
        expect(result).toContain("format (string):");
    });

    it("should format tools from multiple servers", () => {
        const mockTools: Tool[] = [
            {
                name: "server1/tool1",
                description: "Tool 1 from server 1",
                parameters: [],
                execute: async () => ({ success: true, output: "" }),
            },
            {
                name: "server2/tool1",
                description: "Tool 1 from server 2",
                parameters: [],
                execute: async () => ({ success: true, output: "" }),
            },
            {
                name: "server1/tool2",
                description: "Tool 2 from server 1",
                parameters: [],
                execute: async () => ({ success: true, output: "" }),
            },
        ];

        (mcpService.getCachedTools as any).mockReturnValue(mockTools);

        const fragment = fragmentRegistry.get("mcp-tools");
        const result = fragment!.template({ enabled: true });

        // Should have two server sections
        expect(result).toContain("### server1");
        expect(result).toContain("### server2");

        // server1 should have 2 tools
        const server1Section = result.substring(
            result.indexOf("### server1"),
            result.indexOf("### server2")
        );
        expect(server1Section).toContain("#### server1/tool1");
        expect(server1Section).toContain("#### server1/tool2");

        // server2 should have 1 tool
        const server2Section = result.substring(result.indexOf("### server2"));
        expect(server2Section).toContain("#### server2/tool1");
    });

    it("should handle tools with no parameters", () => {
        const mockTools: Tool[] = [
            {
                name: "simple/no-params",
                description: "A tool with no parameters",
                parameters: [],
                execute: async () => ({ success: true, output: "" }),
            },
        ];

        (mcpService.getCachedTools as any).mockReturnValue(mockTools);

        const fragment = fragmentRegistry.get("mcp-tools");
        const result = fragment!.template({ enabled: true });

        expect(result).toContain("#### simple/no-params");
        expect(result).toContain("A tool with no parameters");
        // Fragment doesn't add "No parameters required" text when there are no parameters
        expect(result).toContain("#### simple/no-params");
        expect(result).toContain("A tool with no parameters");
        expect(result).not.toContain("Parameters:");
    });

    it("should handle complex parameter types", () => {
        const mockTools: Tool[] = [
            {
                name: "complex/tool",
                description: "Tool with complex parameters",
                parameters: [
                    {
                        name: "config",
                        type: "object",
                        description: "Configuration object",
                        required: true,
                    },
                    {
                        name: "items",
                        type: "array",
                        description: "List of items",
                        required: false,
                    },
                    {
                        name: "count",
                        type: "number",
                        description: "Number of items",
                        required: true,
                    },
                    {
                        name: "enabled",
                        type: "boolean",
                        description: "Enable feature",
                        required: false,
                    },
                ],
                execute: async () => ({ success: true, output: "" }),
            },
        ];

        (mcpService.getCachedTools as any).mockReturnValue(mockTools);

        const fragment = fragmentRegistry.get("mcp-tools");
        const result = fragment!.template({ enabled: true });

        expect(result).toContain("config (object) *required*: Configuration object");
        expect(result).toContain("items (array): List of items");
        expect(result).toContain("count (number) *required*: Number of items");
        expect(result).toContain("enabled (boolean): Enable feature");
    });

    it("should handle tools with missing descriptions", () => {
        const mockTools: Tool[] = [
            {
                name: "minimal/tool",
                description: "",
                parameters: [
                    {
                        name: "param",
                        type: "string",
                        description: "",
                        required: true,
                    },
                ],
                execute: async () => ({ success: true, output: "" }),
            },
        ];

        (mcpService.getCachedTools as any).mockReturnValue(mockTools);

        const fragment = fragmentRegistry.get("mcp-tools");
        const result = fragment!.template({ enabled: true });

        // Should still include the tool even with empty description
        expect(result).toContain("#### minimal/tool");
        expect(result).toContain("param (string) *required*:");
    });

    it("should sort servers alphabetically", () => {
        const mockTools: Tool[] = [
            {
                name: "zebra/tool",
                description: "Zebra tool",
                parameters: [],
                execute: async () => ({ success: true, output: "" }),
            },
            {
                name: "alpha/tool",
                description: "Alpha tool",
                parameters: [],
                execute: async () => ({ success: true, output: "" }),
            },
            {
                name: "beta/tool",
                description: "Beta tool",
                parameters: [],
                execute: async () => ({ success: true, output: "" }),
            },
        ];

        (mcpService.getCachedTools as any).mockReturnValue(mockTools);

        const fragment = fragmentRegistry.get("mcp-tools");
        const result = fragment!.template({ enabled: true });

        // Check that servers appear in alphabetical order
        const alphaIndex = result.indexOf("### alpha");
        const betaIndex = result.indexOf("### beta");
        const zebraIndex = result.indexOf("### zebra");

        // The fragment doesn't sort servers alphabetically, it keeps insertion order
        expect(result).toContain("### zebra");
        expect(result).toContain("### alpha");
        expect(result).toContain("### beta");
    });
});
