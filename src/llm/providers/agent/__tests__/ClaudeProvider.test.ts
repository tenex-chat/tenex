import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { AISdkTool } from "@/tools/types";
import { z } from "zod";

let createClaudeCodeCalls: Array<{ defaultSettings?: Record<string, unknown> }> = [];
let createSdkMcpServerCalls: { name: string; tools: unknown[] }[] = [];

mock.module("ai-sdk-provider-claude-code", () => ({
    createClaudeCode: (options?: { defaultSettings?: Record<string, unknown> }) => {
        createClaudeCodeCalls.push(options ?? {});
        return (_model: string, _settings: unknown) => ({
            doGenerate: async () => ({}),
            doStream: async () => ({}),
        });
    },
    createSdkMcpServer: (args: { name: string; tools: unknown[] }) => {
        createSdkMcpServerCalls.push(args);
        return { name: args.name, tools: args.tools };
    },
    tool: (
        name: string,
        description: string,
        inputSchema: unknown,
        execute: unknown
    ) => ({ name, description, inputSchema, execute }),
}));

import { ClaudeProvider } from "../ClaudeProvider";

describe("ClaudeProvider", () => {
    let provider: ClaudeProvider;

    const createMockTool = (description = "Test tool"): AISdkTool => ({
        description,
        inputSchema: z.object({ value: z.string().optional() }),
        execute: async () => ({ result: "success" }),
    });

    beforeEach(async () => {
        createClaudeCodeCalls = [];
        createSdkMcpServerCalls = [];
        provider = new ClaudeProvider();
        await provider.initialize({});
    });

    it("creates the provider with Claude defaults", () => {
        expect(createClaudeCodeCalls).toHaveLength(1);
        expect(createClaudeCodeCalls[0]?.defaultSettings).toMatchObject({
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 25,
            thinking: { type: "adaptive" },
            persistSession: false,
            verbose: false,
        });
    });

    it("creates agent settings with TENEX MCP tools and external MCP servers", () => {
        const onStreamStart = () => undefined;
        const tools: Record<string, AISdkTool> = {
            fs_read: createMockTool(),
            fs_write: createMockTool(),
            delegate: createMockTool(),
            mcp__github__search: createMockTool(),
        };

        const model = provider.createModel("sonnet", {
            tools,
            agentName: "Athena",
            workingDirectory: "/tmp/project",
            onStreamStart,
            mcpConfig: {
                enabled: true,
                servers: {
                    github: {
                        command: "npx",
                        args: ["-y", "@modelcontextprotocol/server-github"],
                        env: { GITHUB_TOKEN: "test" },
                    },
                },
            },
        });

        expect(createSdkMcpServerCalls).toHaveLength(1);
        expect(createSdkMcpServerCalls[0]?.name).toBe("tenex");

        const settings = model.agentSettings as {
            cwd?: string;
            permissionMode?: string;
            allowDangerouslySkipPermissions?: boolean;
            maxTurns?: number;
            thinking?: { type: string };
            persistSession?: boolean;
            streamingInput?: string;
            onStreamStart?: unknown;
            mcpServers?: Record<string, unknown>;
        };

        expect(settings.cwd).toBe("/tmp/project");
        expect(settings.permissionMode).toBe("bypassPermissions");
        expect(settings.allowDangerouslySkipPermissions).toBe(true);
        expect(settings.maxTurns).toBe(25);
        expect(settings.thinking).toEqual({ type: "adaptive" });
        expect(settings.persistSession).toBe(false);
        expect(settings.streamingInput).toBe("always");
        expect(settings.onStreamStart).toBe(onStreamStart);
        expect(settings.mcpServers).toBeDefined();
        expect(settings.mcpServers?.tenex).toBeDefined();
        expect(settings.mcpServers?.github).toMatchObject({
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "test" },
        });
    });

    it("honors provider config overrides", () => {
        const model = provider.createModel("opus", {
            tools: {
                shell: createMockTool(),
            },
            providerConfig: {
                effort: "max",
                maxTurns: 9,
                permissionMode: "default",
                thinking: { type: "disabled" },
                allowedTools: ["Read", "LS"],
                disallowedTools: ["Bash"],
                additionalDirectories: ["/tmp/shared"],
                env: { FOO: "bar" },
            },
        });

        const settings = model.agentSettings as {
            effort?: string;
            maxTurns?: number;
            permissionMode?: string;
            allowDangerouslySkipPermissions?: boolean;
            thinking?: { type: string };
            allowedTools?: string[];
            disallowedTools?: string[];
            additionalDirectories?: string[];
            env?: Record<string, string>;
        };

        expect(settings.effort).toBe("max");
        expect(settings.maxTurns).toBe(9);
        expect(settings.permissionMode).toBe("default");
        expect(settings.allowDangerouslySkipPermissions).toBe(false);
        expect(settings.thinking).toEqual({ type: "disabled" });
        expect(settings.allowedTools).toEqual(["Read", "LS"]);
        expect(settings.disallowedTools).toEqual(["Bash"]);
        expect(settings.additionalDirectories).toEqual(["/tmp/shared"]);
        expect(settings.env).toEqual({ FOO: "bar" });
    });

    it("extracts usage metadata and session metadata from provider metadata", () => {
        const usage = ClaudeProvider.extractUsageMetadata(
            "sonnet",
            {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
            },
            {
                "claude-code": {
                    costUsd: 0.42,
                    sessionId: "session_123",
                },
            }
        );

        expect(usage).toMatchObject({
            model: "sonnet",
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            costUsd: 0.42,
        });

        expect(
            ClaudeProvider.extractMetadata({
                "claude-code": {
                    sessionId: "session_123",
                },
            })
        ).toEqual({
            threadId: "session_123",
        });
    });
});
