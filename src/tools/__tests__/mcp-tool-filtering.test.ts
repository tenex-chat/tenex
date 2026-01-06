import { describe, expect, it } from "bun:test";
import { createMockToolContext } from "@/test-utils";
import { getToolsObject } from "../registry";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { Tool as CoreTool } from "ai";

describe("MCP Tool Filtering in getToolsObject", () => {
    // Mock MCP tools
    const mockMcpTools: Record<string, CoreTool<unknown, unknown>> = {
        "mcp__server1__tool_a": {
            description: "Tool A from server1",
            parameters: { type: "object", properties: {} },
            execute: async () => "result_a",
        } as CoreTool<unknown, unknown>,
        "mcp__server1__tool_b": {
            description: "Tool B from server1",
            parameters: { type: "object", properties: {} },
            execute: async () => "result_b",
        } as CoreTool<unknown, unknown>,
        "mcp__server2__tool_c": {
            description: "Tool C from server2",
            parameters: { type: "object", properties: {} },
            execute: async () => "result_c",
        } as CoreTool<unknown, unknown>,
    };

    // Create a mock MCPManager
    const mockMcpManager = {
        getCachedTools: () => mockMcpTools,
    } as unknown as MCPManager;

    // Create context with mock MCPManager
    const mockContext = createMockToolContext({
        mcpManager: mockMcpManager,
    });

    it("should only include MCP tools that are explicitly requested in names array", () => {
        // Request only one specific MCP tool
        const requestedTools = ["read_path", "mcp__server1__tool_a"];

        const tools = getToolsObject(requestedTools, mockContext);

        // Should include the requested static tool
        expect(tools["read_path"]).toBeDefined();

        // Should include ONLY the requested MCP tool
        expect(tools["mcp__server1__tool_a"]).toBeDefined();

        // Should NOT include MCP tools that weren't requested
        expect(tools["mcp__server1__tool_b"]).toBeUndefined();
        expect(tools["mcp__server2__tool_c"]).toBeUndefined();
    });

    it("should include no MCP tools when none are requested", () => {
        // Request only static tools, no MCP tools
        const requestedTools = ["read_path", "shell"];

        const tools = getToolsObject(requestedTools, mockContext);

        // Should include the requested static tools
        expect(tools["read_path"]).toBeDefined();
        expect(tools["shell"]).toBeDefined();

        // Should NOT include any MCP tools
        expect(tools["mcp__server1__tool_a"]).toBeUndefined();
        expect(tools["mcp__server1__tool_b"]).toBeUndefined();
        expect(tools["mcp__server2__tool_c"]).toBeUndefined();
    });

    it("should include multiple requested MCP tools but exclude unrequested ones", () => {
        // Request two MCP tools from the same server
        const requestedTools = ["mcp__server1__tool_a", "mcp__server1__tool_b"];

        const tools = getToolsObject(requestedTools, mockContext);

        // Should include the requested MCP tools
        expect(tools["mcp__server1__tool_a"]).toBeDefined();
        expect(tools["mcp__server1__tool_b"]).toBeDefined();

        // Should NOT include unrequested MCP tools
        expect(tools["mcp__server2__tool_c"]).toBeUndefined();
    });

    it("should handle context without mcpManager gracefully", () => {
        // Create context without mcpManager
        const contextWithoutMcp = createMockToolContext();

        const requestedTools = ["read_path", "mcp__server1__tool_a"];
        const tools = getToolsObject(requestedTools, contextWithoutMcp);

        // Should include the static tool
        expect(tools["read_path"]).toBeDefined();

        // Should NOT include MCP tools (no mcpManager available)
        expect(tools["mcp__server1__tool_a"]).toBeUndefined();
    });
});
