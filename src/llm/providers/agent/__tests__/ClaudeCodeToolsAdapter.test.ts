import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import { logger } from "@/utils/logger";
import type { AISdkTool } from "@/tools/types";
import { z } from "zod";

// Track calls to createSdkMcpServer
let createSdkMcpServerCalls: { name: string; tools: unknown[] }[] = [];

// Mock the module before importing the adapter
mock.module("ai-sdk-provider-claude-code", () => ({
    createSdkMcpServer: (args: { name: string; tools: unknown[] }) => {
        createSdkMcpServerCalls.push(args);
        return { name: args.name, tools: args.tools };
    },
    tool: (name: string, description: string, schema: unknown, execute: unknown) => ({
        name,
        description,
        schema,
        execute,
    }),
}));

// Import after mocking
import { ClaudeCodeToolsAdapter } from "../ClaudeCodeToolsAdapter";

describe("ClaudeCodeToolsAdapter", () => {
    // Create a mock tool with Zod schema (like TENEX tools)
    const createMockTenexTool = (description = "Test tool"): AISdkTool => ({
        description,
        inputSchema: z.object({
            param: z.string().optional(),
        }),
        execute: async () => ({ result: "success" }),
    });

    // Create a mock external MCP tool with JSON Schema (no .safeParseAsync)
    const createMockExternalMcpTool = (description = "External MCP tool"): AISdkTool => ({
        description,
        // JSON Schema format - no .safeParseAsync() method
        inputSchema: {
            type: "object",
            properties: {
                param: { type: "string" },
            },
        } as unknown as z.ZodObject<never>,
        execute: async () => ({ result: "success" }),
    });

    beforeEach(() => {
        createSdkMcpServerCalls = [];
    });

    describe("createSdkMcpServer", () => {
        it("should filter out external MCP tools", () => {
            const tools: Record<string, AISdkTool> = {
                delegate: createMockTenexTool(),
                ask: createMockTenexTool(),
                "mcp__chrome-devtools-mcp__new_page": createMockExternalMcpTool(),
                "mcp__playwright__click": createMockExternalMcpTool(),
            };

            ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            expect(callArgs.name).toBe("tenex");
            // Only delegate and ask should be included (external MCP tools filtered out)
            expect(callArgs.tools).toHaveLength(2);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("delegate");
            expect(toolNames).toContain("ask");
            expect(toolNames).not.toContain("mcp__chrome-devtools-mcp__new_page");
            expect(toolNames).not.toContain("mcp__playwright__click");
        });

        it("should NOT filter out mcp__tenex__* tools (wrapped TENEX tools)", () => {
            const tools: Record<string, AISdkTool> = {
                delegate: createMockTenexTool(),
                "mcp__tenex__lesson_learn": createMockTenexTool(),
                "mcp__tenex__report_write": createMockTenexTool(),
                "mcp__external-server__some_tool": createMockExternalMcpTool(),
            };

            ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            // delegate + 2 mcp__tenex__ tools = 3 (external server filtered out)
            expect(callArgs.tools).toHaveLength(3);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("delegate");
            expect(toolNames).toContain("mcp__tenex__lesson_learn");
            expect(toolNames).toContain("mcp__tenex__report_write");
            expect(toolNames).not.toContain("mcp__external-server__some_tool");
        });

        it("should filter out fs_* tools (Claude Code has built-in equivalents)", () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: createMockTenexTool(),
                fs_write: createMockTenexTool(),
                fs_glob: createMockTenexTool(),
                delegate: createMockTenexTool(),
            };

            ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            expect(callArgs.tools).toHaveLength(1);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("delegate");
            expect(toolNames).not.toContain("fs_read");
            expect(toolNames).not.toContain("fs_write");
            expect(toolNames).not.toContain("fs_glob");
        });

        it("should filter out Claude Code builtin equivalents", () => {
            const tools: Record<string, AISdkTool> = {
                web_fetch: createMockTenexTool(),
                shell: createMockTenexTool(),
                web_search: createMockTenexTool(),
                delegate: createMockTenexTool(),
            };

            ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            expect(callArgs.tools).toHaveLength(1);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("delegate");
            expect(toolNames).not.toContain("web_fetch");
            expect(toolNames).not.toContain("shell");
            expect(toolNames).not.toContain("web_search");
        });

        it("should return undefined when all tools are filtered out", () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: createMockTenexTool(),
                web_fetch: createMockTenexTool(),
                "mcp__external__tool": createMockExternalMcpTool(),
            };

            const server = ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(server).toBeUndefined();
            expect(createSdkMcpServerCalls).toHaveLength(0);
        });

        it("should handle empty tools object", () => {
            const tools: Record<string, AISdkTool> = {};

            const server = ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(server).toBeUndefined();
            expect(createSdkMcpServerCalls).toHaveLength(0);
        });

        it("should include todo_write tool (TENEX-specific)", () => {
            const tools: Record<string, AISdkTool> = {
                todo_write: createMockTenexTool(),
                delegate: createMockTenexTool(),
            };

            ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            expect(callArgs.tools).toHaveLength(2);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("todo_write");
            expect(toolNames).toContain("delegate");
        });

        it("should properly handle mix of all tool types", () => {
            const tools: Record<string, AISdkTool> = {
                // TENEX tools (should be included)
                delegate: createMockTenexTool(),
                ask: createMockTenexTool(),
                lesson_learn: createMockTenexTool(),
                report_write: createMockTenexTool(),
                todo_write: createMockTenexTool(),
                // fs_* tools (filtered - Claude Code has built-ins)
                fs_read: createMockTenexTool(),
                fs_write: createMockTenexTool(),
                // Claude Code builtin equivalents (filtered)
                shell: createMockTenexTool(),
                web_fetch: createMockTenexTool(),
                web_search: createMockTenexTool(),
                // External MCP tools (filtered - passed directly to Claude Code)
                "mcp__chrome-devtools__navigate": createMockExternalMcpTool(),
                "mcp__playwright__click": createMockExternalMcpTool(),
                // TENEX MCP tools (NOT filtered - these are wrapped TENEX tools)
                "mcp__tenex__custom_tool": createMockTenexTool(),
            };

            ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            // delegate, ask, lesson_learn, report_write, todo_write, mcp__tenex__custom_tool = 6
            expect(callArgs.tools).toHaveLength(6);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            // Should be included
            expect(toolNames).toContain("delegate");
            expect(toolNames).toContain("ask");
            expect(toolNames).toContain("lesson_learn");
            expect(toolNames).toContain("report_write");
            expect(toolNames).toContain("todo_write");
            expect(toolNames).toContain("mcp__tenex__custom_tool");
            // Should be filtered
            expect(toolNames).not.toContain("fs_read");
            expect(toolNames).not.toContain("fs_write");
            expect(toolNames).not.toContain("shell");
            expect(toolNames).not.toContain("web_fetch");
            expect(toolNames).not.toContain("web_search");
            expect(toolNames).not.toContain("mcp__chrome-devtools__navigate");
            expect(toolNames).not.toContain("mcp__playwright__click");
        });

        it("should treat external MCP server named 'tenex' as external (metadata-based detection)", () => {
            // Simulate scenario where user configures external MCP server named "tenex"
            // These tools would have JSON Schema format (no safeParseAsync), NOT Zod schemas
            const tools: Record<string, AISdkTool> = {
                delegate: createMockTenexTool(), // Real TENEX tool with Zod schema
                // External MCP server named "tenex" - has JSON Schema, NOT Zod
                "mcp__tenex__external_tool": createMockExternalMcpTool(),
                "mcp__tenex__another_external": createMockExternalMcpTool(),
            };

            ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            // Only the real TENEX tool should be included
            expect(callArgs.tools).toHaveLength(1);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("delegate");
            // External tools named mcp__tenex__* but with JSON Schema should be filtered
            expect(toolNames).not.toContain("mcp__tenex__external_tool");
            expect(toolNames).not.toContain("mcp__tenex__another_external");
        });

        it("should handle primitive schema types without throwing", () => {
            const warnSpy = spyOn(logger, "warn");

            // Create a tool with a primitive schema (e.g., what z.string() looks like at runtime)
            const primitiveSchemaValue = "primitive" as unknown as z.ZodObject<never>;
            const toolWithPrimitiveSchema: AISdkTool = {
                description: "Tool with primitive schema",
                inputSchema: primitiveSchemaValue,
                execute: async () => ({ result: "success" }),
            };

            const tools: Record<string, AISdkTool> = {
                primitive_tool: toolWithPrimitiveSchema,
                delegate: createMockTenexTool(),
            };

            // Should not throw
            expect(() => ClaudeCodeToolsAdapter.createSdkMcpServer(tools)).not.toThrow();

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            // Both tools should be attempted to be wrapped (primitive_tool with empty schema)
            expect(callArgs.tools).toHaveLength(2);

            // Verify warning was logged for the primitive schema
            expect(warnSpy).toHaveBeenCalled();
            const warnCalls = warnSpy.mock.calls;
            const primitiveSchemaWarn = warnCalls.find(
                (call) => typeof call[0] === "string" && call[0].includes("primitive_tool")
            );
            expect(primitiveSchemaWarn).toBeDefined();

            warnSpy.mockRestore();
        });

        it("should log debug info when all tools are filtered (external-only scenario)", () => {
            const debugSpy = spyOn(logger, "debug");

            const tools: Record<string, AISdkTool> = {
                "mcp__external__tool1": createMockExternalMcpTool(),
                "mcp__external__tool2": createMockExternalMcpTool(),
            };

            const server = ClaudeCodeToolsAdapter.createSdkMcpServer(tools);

            expect(server).toBeUndefined();
            expect(createSdkMcpServerCalls).toHaveLength(0);

            // Verify debug logging happened for the all-filtered case
            expect(debugSpy).toHaveBeenCalled();
            const debugCalls = debugSpy.mock.calls;
            const noLocalToolsLog = debugCalls.find(
                (call) => typeof call[0] === "string" && call[0].includes("No local tools to wrap")
            );
            expect(noLocalToolsLog).toBeDefined();

            debugSpy.mockRestore();
        });
    });
});
