import { describe, expect, it } from "bun:test";
import { createMockAgent, createMockExecutionEnvironment } from "@/test-utils";
import { getToolsObject } from "../registry";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { Tool as CoreTool } from "ai";

describe("MCP access filtering in getToolsObject", () => {
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

    const mockMcpManager = {
        getCachedTools: () => mockMcpTools,
    } as unknown as MCPManager;

    const contextWithServer1Access = createMockExecutionEnvironment({
        agent: createMockAgent({ mcpAccess: ["server1"] }),
        mcpManager: mockMcpManager,
    });

    it("includes external MCP tools from servers the agent can access", () => {
        const tools = getToolsObject(["ask"], contextWithServer1Access);

        expect(tools.ask).toBeDefined();
        expect(tools.mcp__server1__tool_a).toBeDefined();
        expect(tools.mcp__server1__tool_b).toBeDefined();
        expect(tools.mcp__server2__tool_c).toBeUndefined();
    });

    it("does not include MCP tools when the agent has no server access", () => {
        const contextWithoutAccess = createMockExecutionEnvironment({
            agent: createMockAgent({ mcpAccess: [] }),
            mcpManager: mockMcpManager,
        });

        const tools = getToolsObject(["ask"], contextWithoutAccess);

        expect(tools.ask).toBeDefined();
        expect(tools.mcp__server1__tool_a).toBeUndefined();
        expect(tools.mcp__server1__tool_b).toBeUndefined();
        expect(tools.mcp__server2__tool_c).toBeUndefined();
    });

    it("ignores explicit mcp__ entries in configured tool names", () => {
        const contextWithoutAccess = createMockExecutionEnvironment({
            agent: createMockAgent({ mcpAccess: [] }),
            mcpManager: mockMcpManager,
        });

        const tools = getToolsObject(["ask", "mcp__server1__tool_a"], contextWithoutAccess);

        expect(tools.ask).toBeDefined();
        expect(tools.mcp__server1__tool_a).toBeUndefined();
    });

    it("handles context without mcpManager gracefully", () => {
        const contextWithoutMcp = createMockExecutionEnvironment({
            agent: createMockAgent({ mcpAccess: ["server1"] }),
        });

        const tools = getToolsObject(["ask"], contextWithoutMcp);

        expect(tools.ask).toBeDefined();
        expect(tools.mcp__server1__tool_a).toBeUndefined();
    });
});
