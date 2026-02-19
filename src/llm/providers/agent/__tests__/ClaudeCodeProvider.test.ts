import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { AISdkTool } from "@/tools/types";
import { z } from "zod";

// Mock the ai-sdk-provider-claude-code module
mock.module("ai-sdk-provider-claude-code", () => ({
    createClaudeCode: () => {
        // Return a function that returns a mock language model
        return (_model: string, _options: unknown) => ({
            doGenerate: async () => ({}),
            doStream: async () => ({}),
        });
    },
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
}));

// Import after mocking
import { ClaudeCodeProvider } from "../ClaudeCodeProvider";

describe("ClaudeCodeProvider", () => {
    let provider: ClaudeCodeProvider;

    // Create a mock tool with Zod schema
    const createMockTenexTool = (description = "Test tool"): AISdkTool => ({
        description,
        inputSchema: z.object({ param: z.string().optional() }),
        execute: async () => ({ result: "success" }),
    });

    beforeEach(async () => {
        provider = new ClaudeCodeProvider();
        await provider.initialize({});
    });

    describe("computeDisallowedBuiltinTools", () => {
        // Access the private method via type assertion for testing
        const getDisallowedTools = (regularTools: string[], mcpTools: string[]): string[] => {
            // @ts-expect-error - accessing private method for testing
            return provider.computeDisallowedBuiltinTools(regularTools, mcpTools);
        };

        describe("always disallowed tools", () => {
            it("should always disallow AskUserQuestion", () => {
                const disallowed = getDisallowedTools([], []);
                expect(disallowed).toContain("AskUserQuestion");
            });
        });

        describe("file system tool blocking", () => {
            it("should disable ALL FS built-in tools when agent has NO fs capability", () => {
                // Agent with no fs_* tools and no MCP fs tools
                const disallowed = getDisallowedTools(["delegate", "ask"], []);

                expect(disallowed).toContain("Read");
                expect(disallowed).toContain("Write");
                expect(disallowed).toContain("Edit");
                expect(disallowed).toContain("Glob");
                expect(disallowed).toContain("Grep");
                expect(disallowed).toContain("LS");
                expect(disallowed).toContain("NotebookEdit");
            });

            it("should only disable specific FS built-ins that TENEX provides, not all FS tools", () => {
                // Agent with fs_read - has FS capability
                const disallowed = getDisallowedTools(["fs_read", "delegate"], []);

                // Read should be disabled because fs_read is provided
                expect(disallowed).toContain("Read");

                // But Write, Edit, Grep should NOT be disabled - agent has FS capability
                // but doesn't have the specific TENEX tools for these
                expect(disallowed).not.toContain("Write");
                expect(disallowed).not.toContain("Edit");
                expect(disallowed).not.toContain("Grep");
            });

            it("should disable specific FS built-in when TENEX provides that specific tool", () => {
                const disallowed = getDisallowedTools(["fs_read", "fs_write"], []);

                expect(disallowed).toContain("Read");
                expect(disallowed).toContain("Write");
                // Edit is not provided, but since agent has fs_*, it's not blanket disabled
            });

            it("should disable specific FS built-ins when MCP provides equivalents", () => {
                // Agent has MCP fs tools - so has FS capability
                const disallowed = getDisallowedTools(
                    ["delegate"],
                    ["mcp__tenex__fs_read", "mcp__tenex__fs_write"]
                );

                // These should be disabled because MCP provides equivalents
                expect(disallowed).toContain("Read");
                expect(disallowed).toContain("Write");

                // These should NOT be disabled - agent has FS capability via MCP
                // but MCP doesn't provide Edit, Glob, Grep equivalents
                expect(disallowed).not.toContain("Edit");
                expect(disallowed).not.toContain("Glob");
                expect(disallowed).not.toContain("Grep");
            });
        });

        describe("tool mapping - TENEX to built-in", () => {
            it("should disable Read when fs_read is provided", () => {
                const disallowed = getDisallowedTools(["fs_read", "fs_write", "fs_glob"], []);
                expect(disallowed).toContain("Read");
            });

            it("should disable Write when fs_write is provided", () => {
                const disallowed = getDisallowedTools(["fs_read", "fs_write", "fs_glob"], []);
                expect(disallowed).toContain("Write");
            });

            it("should disable Edit when fs_edit is provided", () => {
                const disallowed = getDisallowedTools(["fs_read", "fs_write", "fs_edit"], []);
                expect(disallowed).toContain("Edit");
            });

            it("should disable Glob when fs_glob is provided", () => {
                const disallowed = getDisallowedTools(["fs_read", "fs_glob"], []);
                expect(disallowed).toContain("Glob");
            });

            it("should disable Grep when fs_grep is provided", () => {
                const disallowed = getDisallowedTools(["fs_read", "fs_grep"], []);
                expect(disallowed).toContain("Grep");
            });

            it("should disable LS when fs_glob is provided", () => {
                const disallowed = getDisallowedTools(["fs_read", "fs_glob"], []);
                expect(disallowed).toContain("LS");
            });

            it("should disable WebFetch when web_fetch is provided", () => {
                const disallowed = getDisallowedTools(["web_fetch", "fs_read"], []);
                expect(disallowed).toContain("WebFetch");
            });

            it("should disable WebSearch when web_search is provided", () => {
                const disallowed = getDisallowedTools(["web_search", "fs_read"], []);
                expect(disallowed).toContain("WebSearch");
            });

            it("should disable Bash when shell is provided", () => {
                const disallowed = getDisallowedTools(["shell", "fs_read"], []);
                expect(disallowed).toContain("Bash");
            });

            it("should disable Task when delegate is provided", () => {
                const disallowed = getDisallowedTools(["delegate", "fs_read"], []);
                expect(disallowed).toContain("Task");
            });
        });

        describe("MCP tool pattern matching", () => {
            it("should disable Read when mcp__*__fs_read is provided", () => {
                const disallowed = getDisallowedTools(
                    ["fs_read"], // Need at least one fs tool to have FS capability
                    ["mcp__tenex__fs_read"]
                );
                expect(disallowed).toContain("Read");
            });

            it("should disable Write when mcp__*__write_file is provided", () => {
                const disallowed = getDisallowedTools(
                    ["fs_read"],
                    ["mcp__external__write_file"]
                );
                expect(disallowed).toContain("Write");
            });

            it("should disable Bash when mcp__*__shell is provided", () => {
                const disallowed = getDisallowedTools(
                    ["fs_read"],
                    ["mcp__external__shell"]
                );
                expect(disallowed).toContain("Bash");
            });

            it("should disable Bash when mcp__*__execute is provided", () => {
                const disallowed = getDisallowedTools(
                    ["fs_read"],
                    ["mcp__external__execute"]
                );
                expect(disallowed).toContain("Bash");
            });
        });

        describe("full capability agents", () => {
            it("should disable all overlapping built-ins for full-capability agent", () => {
                const disallowed = getDisallowedTools(
                    ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "shell", "web_fetch", "web_search", "delegate"],
                    []
                );

                expect(disallowed).toContain("AskUserQuestion");
                expect(disallowed).toContain("Read");
                expect(disallowed).toContain("Write");
                expect(disallowed).toContain("Edit");
                expect(disallowed).toContain("Glob");
                expect(disallowed).toContain("Grep");
                expect(disallowed).toContain("LS");
                expect(disallowed).toContain("WebFetch");
                expect(disallowed).toContain("WebSearch");
                expect(disallowed).toContain("Bash");
                expect(disallowed).toContain("Task");
            });
        });

        describe("restricted agents", () => {
            it("should disable ALL FS built-ins for agents with only delegation tools", () => {
                const disallowed = getDisallowedTools(["delegate", "ask", "lesson_learn"], []);

                // No fs capability = all FS built-ins disabled
                expect(disallowed).toContain("Read");
                expect(disallowed).toContain("Write");
                expect(disallowed).toContain("Edit");
                expect(disallowed).toContain("Glob");
                expect(disallowed).toContain("Grep");
                expect(disallowed).toContain("LS");
                expect(disallowed).toContain("NotebookEdit");

                // delegate is provided, so Task should be disabled
                expect(disallowed).toContain("Task");

                // No shell/web tools provided, so those built-ins should NOT be disabled
                expect(disallowed).not.toContain("Bash");
                expect(disallowed).not.toContain("WebFetch");
                expect(disallowed).not.toContain("WebSearch");
            });

            it("should allow Bash for restricted agent without shell tool", () => {
                const disallowed = getDisallowedTools(["delegate", "ask"], []);

                // shell not provided, so Bash should NOT be disabled
                // Agent can still use Bash for commands
                expect(disallowed).not.toContain("Bash");
            });

            it("should allow WebFetch for restricted agent without web_fetch tool", () => {
                const disallowed = getDisallowedTools(["delegate", "ask"], []);

                // web_fetch not provided, so WebFetch should NOT be disabled
                expect(disallowed).not.toContain("WebFetch");
            });
        });
    });

    describe("createAgentSettings integration", () => {
        it("should include computed disallowedTools in settings", () => {
            const tools: Record<string, AISdkTool> = {
                fs_read: createMockTenexTool(),
                fs_write: createMockTenexTool(),
                delegate: createMockTenexTool(),
            };

            const model = provider.createModel("claude-sonnet-4-20250514", {
                tools,
                workingDirectory: "/test/path",
            });

            expect(model.agentSettings).toBeDefined();
            const settings = model.agentSettings as { disallowedTools?: string[] };
            expect(settings.disallowedTools).toBeDefined();
            expect(settings.disallowedTools).toContain("AskUserQuestion");
            expect(settings.disallowedTools).toContain("Read");
            expect(settings.disallowedTools).toContain("Write");
            expect(settings.disallowedTools).toContain("Task");
        });

        it("should disable ALL FS tools for agent with no FS capability", () => {
            const tools: Record<string, AISdkTool> = {
                delegate: createMockTenexTool(),
                ask: createMockTenexTool(),
            };

            const model = provider.createModel("claude-sonnet-4-20250514", {
                tools,
                workingDirectory: "/test/path",
            });

            const settings = model.agentSettings as { disallowedTools?: string[] };
            expect(settings.disallowedTools).toContain("Read");
            expect(settings.disallowedTools).toContain("Write");
            expect(settings.disallowedTools).toContain("Edit");
            expect(settings.disallowedTools).toContain("Glob");
            expect(settings.disallowedTools).toContain("Grep");
            expect(settings.disallowedTools).toContain("LS");
            expect(settings.disallowedTools).toContain("NotebookEdit");
        });
    });
});
