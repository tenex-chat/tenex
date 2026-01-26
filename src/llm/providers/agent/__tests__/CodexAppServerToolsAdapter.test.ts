import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { AISdkTool } from "@/tools/types";

// Track calls to createSdkMcpServer
let createSdkMcpServerCalls: { name: string; tools: unknown[] }[] = [];

// Mock the module before importing the adapter
mock.module("ai-sdk-provider-codex-app-server", () => ({
    createSdkMcpServer: (args: { name: string; tools: unknown[] }) => {
        createSdkMcpServerCalls.push(args);
        return { name: args.name, tools: args.tools };
    },
    tool: (config: { name: string; description: string; parameters: unknown; execute: unknown }) => config,
}));

// Import after mocking
import { CodexAppServerToolsAdapter, isCodexBuiltinTool, CODEX_BUILTIN_PREFIXES } from "../CodexAppServerToolsAdapter";

describe("CodexAppServerToolsAdapter", () => {
    const mockTool: AISdkTool = {
        description: "Test tool",
        inputSchema: {},
        execute: async () => ({ result: "success" }),
    };

    beforeEach(() => {
        // Reset call tracking before each test
        createSdkMcpServerCalls = [];
    });

    describe("isCodexBuiltinTool", () => {
        it("should identify fs_* tools as built-in", () => {
            expect(isCodexBuiltinTool("fs_read")).toBe(true);
            expect(isCodexBuiltinTool("fs_write")).toBe(true);
            expect(isCodexBuiltinTool("fs_glob")).toBe(true);
            expect(isCodexBuiltinTool("fs_grep")).toBe(true);
            expect(isCodexBuiltinTool("fs_edit")).toBe(true);
            expect(isCodexBuiltinTool("fs_anything")).toBe(true);
        });

        it("should NOT identify todo_write as built-in", () => {
            expect(isCodexBuiltinTool("todo_write")).toBe(false);
        });

        it("should NOT identify TENEX tools as built-in", () => {
            expect(isCodexBuiltinTool("delegate")).toBe(false);
            expect(isCodexBuiltinTool("ask")).toBe(false);
            expect(isCodexBuiltinTool("lesson_learn")).toBe(false);
            expect(isCodexBuiltinTool("report_write")).toBe(false);
            expect(isCodexBuiltinTool("conversation_get")).toBe(false);
        });

        it("should match all defined prefixes", () => {
            for (const prefix of CODEX_BUILTIN_PREFIXES) {
                expect(isCodexBuiltinTool(`${prefix}test`)).toBe(true);
            }
        });
    });

    describe("CODEX_BUILTIN_PREFIXES", () => {
        it("should only contain fs_ prefix", () => {
            expect(CODEX_BUILTIN_PREFIXES).toEqual(["fs_"]);
        });
    });

    describe("createSdkMcpServer", () => {
        it("should filter out fs_* tools (Codex has built-in file tools)", () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: mockTool,
                fs_write: mockTool,
                fs_glob: mockTool,
                fs_grep: mockTool,
                delegate: mockTool,
                ask: mockTool,
            };

            CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            // Assert the arguments passed to createSdkMcpServer
            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            expect(callArgs.name).toBe("tenex");
            expect(callArgs.tools).toHaveLength(2);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("delegate");
            expect(toolNames).toContain("ask");
            expect(toolNames).not.toContain("fs_read");
            expect(toolNames).not.toContain("fs_write");
        });

        it("should NOT filter out todo_write tool (Codex does not have built-in todo)", () => {
            const tools: Record<string, AISdkTool> = {
                todo_write: mockTool,
                delegate: mockTool,
                fs_read: mockTool,
            };

            CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            // Assert the arguments passed to createSdkMcpServer
            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            expect(callArgs.tools).toHaveLength(2);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("todo_write");
            expect(toolNames).toContain("delegate");
            expect(toolNames).not.toContain("fs_read");
        });

        it("should include all TENEX-specific tools", () => {
            const tools: Record<string, AISdkTool> = {
                // TENEX tools that should be included
                todo_write: mockTool,
                delegate: mockTool,
                delegate_followup: mockTool,
                delegate_crossproject: mockTool,
                ask: mockTool,
                lesson_learn: mockTool,
                lesson_get: mockTool,
                report_write: mockTool,
                report_read: mockTool,
                reports_list: mockTool,
                conversation_get: mockTool,
                conversation_list: mockTool,
                project_list: mockTool,
                schedule_task: mockTool,
                // Codex built-in tools that should be filtered
                fs_read: mockTool,
                fs_write: mockTool,
                fs_glob: mockTool,
                fs_grep: mockTool,
                fs_edit: mockTool,
            };

            CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            // Assert the arguments passed to createSdkMcpServer
            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];

            // 19 total - 5 fs_* tools = 14 tools
            expect(callArgs.tools).toHaveLength(14);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("todo_write");
            expect(toolNames.filter((n: string) => n.startsWith("fs_"))).toHaveLength(0);
        });

        it("should return undefined when no tools remain after filtering", () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: mockTool,
                fs_write: mockTool,
            };

            const server = CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            // All tools filtered out - createSdkMcpServer should not be called
            expect(server).toBeUndefined();
            expect(createSdkMcpServerCalls).toHaveLength(0);
        });

        it("should handle empty tools object", () => {
            const tools: Record<string, AISdkTool> = {};

            const server = CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            expect(server).toBeUndefined();
            expect(createSdkMcpServerCalls).toHaveLength(0);
        });
    });
});
