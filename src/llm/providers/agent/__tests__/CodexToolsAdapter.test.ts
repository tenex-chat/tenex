import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { AISdkTool } from "@/tools/types";

// Track calls to createSdkMcpServer for adapter assertions.
let createLocalMcpServerCalls: { name: string; tools: unknown[] }[] = [];

mock.module("ai-sdk-provider-codex-cli", () => ({
    createLocalMcpServer: async (args: { name: string; tools: unknown[] }) => {
        createLocalMcpServerCalls.push(args);
        return {
            config: {
                transport: "http",
                url: `http://127.0.0.1/${args.name}`,
                bearerToken: "test-token",
            },
            url: `http://127.0.0.1/${args.name}`,
            port: 8080,
            stop: async () => undefined,
        };
    },
    tool: (config: { name: string; description: string; parameters: unknown; execute: unknown }) => config,
}));

import { createSdkMcpServer } from "../CodexToolsAdapter";

describe("CodexToolsAdapter", () => {
    const mockTool: AISdkTool = {
        description: "Test tool",
        inputSchema: {},
        execute: async () => ({ result: "success" }),
    };

    beforeEach(() => {
        createLocalMcpServerCalls = [];
    });

    describe("createSdkMcpServer", () => {
        it("should include fs_* tools", async () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: mockTool,
                fs_write: mockTool,
                fs_glob: mockTool,
                fs_grep: mockTool,
                delegate: mockTool,
                ask: mockTool,
            };

            createSdkMcpServer(tools, { agentName: "test" });

            expect(createLocalMcpServerCalls).toHaveLength(0);
            const server = createSdkMcpServer(tools, { agentName: "test" });
            const config = await server?._start();
            const callArgs = createLocalMcpServerCalls[0];
            expect(callArgs.name).toBe("tenex_local_tools");
            expect(callArgs.tools).toHaveLength(Object.keys(tools).length);
            expect(config).toEqual({
                transport: "http",
                url: "http://127.0.0.1/tenex_local_tools",
                httpHeaders: {
                    Authorization: "Bearer test-token",
                },
            });

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("delegate");
            expect(toolNames).toContain("ask");
            expect(toolNames).toContain("fs_read");
            expect(toolNames).toContain("fs_write");
            expect(toolNames).toContain("fs_glob");
            expect(toolNames).toContain("fs_grep");
        });

        it("should include shell tool", async () => {
            const tools: Record<string, AISdkTool> = {
                shell: mockTool,
                delegate: mockTool,
                fs_read: mockTool,
            };

            const server = createSdkMcpServer(tools, { agentName: "test" });
            await server?._start();

            expect(createLocalMcpServerCalls).toHaveLength(1);
            const callArgs = createLocalMcpServerCalls[0];
            expect(callArgs.tools).toHaveLength(Object.keys(tools).length);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("shell");
            expect(toolNames).toContain("delegate");
            expect(toolNames).toContain("fs_read");
        });

        it("should include all provided tools", async () => {
            const tools: Record<string, AISdkTool> = {
                todo_write: mockTool,
                delegate: mockTool,
                delegate_followup: mockTool,
                delegate_crossproject: mockTool,
                ask: mockTool,
                lesson_learn: mockTool,
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

            const server = createSdkMcpServer(tools, { agentName: "test" });
            await server?._start();

            expect(createLocalMcpServerCalls).toHaveLength(1);
            const callArgs = createLocalMcpServerCalls[0];
            expect(callArgs.tools).toHaveLength(Object.keys(tools).length);

            const toolNames = callArgs.tools.map((t: unknown) => (t as { name: string }).name);
            expect(toolNames).toContain("todo_write");
            expect(toolNames).toContain("shell");
            expect(toolNames.filter((n: string) => n.startsWith("fs_"))).toHaveLength(5);
        });

        it("should create server with only fs_* tools", async () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: mockTool,
                fs_write: mockTool,
            };

            const server = createSdkMcpServer(tools, { agentName: "test" });
            const config = await server?._start();

            expect(server).toBeDefined();
            expect(createLocalMcpServerCalls).toHaveLength(1);
            expect(createLocalMcpServerCalls[0].tools).toHaveLength(Object.keys(tools).length);
            expect(config).toBeDefined();
        });

        it("should allow overriding the internal server name", async () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: mockTool,
            };

            const server = createSdkMcpServer(tools, {
                agentName: "test",
                serverName: "tenex_local_tools_2",
            });
            await server?._start();

            expect(createLocalMcpServerCalls).toHaveLength(1);
            expect(createLocalMcpServerCalls[0].name).toBe("tenex_local_tools_2");
        });

        it("should handle empty tools object", () => {
            const tools: Record<string, AISdkTool> = {};

            const server = createSdkMcpServer(tools, { agentName: "test" });

            expect(server).toBeUndefined();
            expect(createLocalMcpServerCalls).toHaveLength(0);
        });
    });
});
