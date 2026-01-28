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
import { CodexAppServerToolsAdapter } from "../CodexAppServerToolsAdapter";

describe("CodexAppServerToolsAdapter", () => {
    const mockTool: AISdkTool = {
        description: "Test tool",
        inputSchema: {},
        execute: async () => ({ result: "success" }),
    };

    beforeEach(() => {
        createSdkMcpServerCalls = [];
    });

    describe("createSdkMcpServer", () => {
        it("should include fs_* tools", () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: mockTool,
                fs_write: mockTool,
                fs_glob: mockTool,
                fs_grep: mockTool,
                delegate: mockTool,
                ask: mockTool,
            };

            CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            expect(callArgs.name).toBe("tenex");
            expect(callArgs.tools).toHaveLength(Object.keys(tools).length);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("delegate");
            expect(toolNames).toContain("ask");
            expect(toolNames).toContain("fs_read");
            expect(toolNames).toContain("fs_write");
            expect(toolNames).toContain("fs_glob");
            expect(toolNames).toContain("fs_grep");
        });

        it("should include shell tool", () => {
            const tools: Record<string, AISdkTool> = {
                shell: mockTool,
                delegate: mockTool,
                fs_read: mockTool,
            };

            CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            expect(callArgs.tools).toHaveLength(Object.keys(tools).length);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("shell");
            expect(toolNames).toContain("delegate");
            expect(toolNames).toContain("fs_read");
        });

        it("should include all provided tools", () => {
            const tools: Record<string, AISdkTool> = {
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
                shell: mockTool,
                fs_read: mockTool,
                fs_write: mockTool,
                fs_glob: mockTool,
                fs_grep: mockTool,
                fs_edit: mockTool,
            };

            CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            expect(createSdkMcpServerCalls).toHaveLength(1);
            const callArgs = createSdkMcpServerCalls[0];
            expect(callArgs.tools).toHaveLength(Object.keys(tools).length);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("todo_write");
            expect(toolNames).toContain("shell");
            expect(toolNames.filter((n: string) => n.startsWith("fs_"))).toHaveLength(5);
        });

        it("should create server with only fs_* tools", () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: mockTool,
                fs_write: mockTool,
            };

            const server = CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            expect(server).toBeDefined();
            expect(createSdkMcpServerCalls).toHaveLength(1);
            expect(createSdkMcpServerCalls[0].tools).toHaveLength(Object.keys(tools).length);
        });

        it("should handle empty tools object", () => {
            const tools: Record<string, AISdkTool> = {};

            const server = CodexAppServerToolsAdapter.createSdkMcpServer(tools, { agentName: "test" });

            expect(server).toBeUndefined();
            expect(createSdkMcpServerCalls).toHaveLength(0);
        });
    });
});
