import { describe, expect, it } from "bun:test";
import { createMockAgent, createMockExecutionEnvironment } from "@/test-utils";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { Tool as CoreTool } from "ai";
import { getToolsObject } from "../registry";

describe("MCP Tool Filtering in getToolsObject", () => {
    const mockMcpTools: Record<string, CoreTool<unknown, unknown>> = {
        mcp__server1__tool_a: {
            description: "Tool A from server1",
            parameters: { type: "object", properties: {} },
            execute: async () => "result_a",
        } as CoreTool<unknown, unknown>,
        mcp__server1__tool_b: {
            description: "Tool B from server1",
            parameters: { type: "object", properties: {} },
            execute: async () => "result_b",
        } as CoreTool<unknown, unknown>,
        mcp__server2__tool_c: {
            description: "Tool C from server2",
            parameters: { type: "object", properties: {} },
            execute: async () => "result_c",
        } as CoreTool<unknown, unknown>,
        mcp__tenex__internal_tool: {
            description: "Internal TENEX tool",
            parameters: { type: "object", properties: {} },
            execute: async () => "internal",
        } as CoreTool<unknown, unknown>,
    };

    const mockMcpManager = {
        getCachedTools: () => mockMcpTools,
    } as unknown as MCPManager;

    it("includes MCP tools from server-level agent access", () => {
        const context = createMockExecutionEnvironment({
            agent: createMockAgent({ mcpAccess: ["server1"] }),
            mcpManager: mockMcpManager,
        });

        const tools = getToolsObject([], context);

        expect(tools.mcp__server1__tool_a).toBeDefined();
        expect(tools.mcp__server1__tool_b).toBeDefined();
        expect(tools.mcp__server2__tool_c).toBeUndefined();
    });

    it("does not include MCP tools when no server access is configured", () => {
        const context = createMockExecutionEnvironment({
            mcpManager: mockMcpManager,
        });

        const tools = getToolsObject(["mcp__server1__tool_a"], context);

        expect(tools.mcp__server1__tool_a).toBeUndefined();
        expect(tools.mcp__server1__tool_b).toBeUndefined();
        expect(tools.mcp__server2__tool_c).toBeUndefined();
    });

    it("skips MCP tools from inaccessible servers", () => {
        const context = createMockExecutionEnvironment({
            agent: createMockAgent({ mcpAccess: ["server2"] }),
            mcpManager: mockMcpManager,
        });

        const tools = getToolsObject([], context);

        expect(tools.mcp__server1__tool_a).toBeUndefined();
        expect(tools.mcp__server1__tool_b).toBeUndefined();
        expect(tools.mcp__server2__tool_c).toBeDefined();
    });

    it("skips internal tenex MCP tools from external MCP access injection", () => {
        const context = createMockExecutionEnvironment({
            agent: createMockAgent({ mcpAccess: ["tenex"] }),
            mcpManager: mockMcpManager,
        });

        const tools = getToolsObject([], context);

        expect(tools.mcp__tenex__internal_tool).toBeUndefined();
    });

    it("handles context without mcpManager gracefully", () => {
        const context = createMockExecutionEnvironment({
            agent: createMockAgent({ mcpAccess: ["server1"] }),
        });

        const tools = getToolsObject([], context);

        expect(tools.mcp__server1__tool_a).toBeUndefined();
    });
});
