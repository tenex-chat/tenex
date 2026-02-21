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

/**
 * Full set of TENEX tools that a fully-capable agent would have.
 * Used to test that all corresponding built-in tools are disabled.
 */
const FULL_CAPABILITY_TOOLS = [
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_glob",
    "fs_grep",
    "shell",
    "web_fetch",
    "web_search",
    "delegate",
    "todo_write",
] as const;

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

        describe("always-disabled built-in tools (FS + Bash)", () => {
            it("should disable all TENEX-controlled built-ins unconditionally", () => {
                const disallowed = getDisallowedTools([], []);

                expect(disallowed).toContain("Read");
                expect(disallowed).toContain("Write");
                expect(disallowed).toContain("Edit");
                expect(disallowed).toContain("Glob");
                expect(disallowed).toContain("Grep");
                expect(disallowed).toContain("LS");
                expect(disallowed).toContain("NotebookEdit");
                expect(disallowed).toContain("Bash");
                expect(disallowed).toContain("TaskOutput");
            });

            it("should disable all TENEX-controlled built-ins regardless of agent tools", () => {
                const disallowed = getDisallowedTools(
                    ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "shell"],
                    []
                );

                expect(disallowed).toContain("Read");
                expect(disallowed).toContain("Write");
                expect(disallowed).toContain("Edit");
                expect(disallowed).toContain("Glob");
                expect(disallowed).toContain("Grep");
                expect(disallowed).toContain("LS");
                expect(disallowed).toContain("NotebookEdit");
                expect(disallowed).toContain("Bash");
                expect(disallowed).toContain("TaskOutput");
            });
        });

        describe("conditionally disabled built-in tools", () => {
            it("should disable WebFetch when web_fetch is provided", () => {
                const disallowed = getDisallowedTools(["web_fetch"], []);
                expect(disallowed).toContain("WebFetch");
            });

            it("should disable WebSearch when web_search is provided", () => {
                const disallowed = getDisallowedTools(["web_search"], []);
                expect(disallowed).toContain("WebSearch");
            });

            it("should disable Task when delegate is provided", () => {
                const disallowed = getDisallowedTools(["delegate"], []);
                expect(disallowed).toContain("Task");
            });

            it("should disable TodoWrite when todo_write is provided", () => {
                const disallowed = getDisallowedTools(["todo_write"], []);
                expect(disallowed).toContain("TodoWrite");
            });

            it("should NOT disable conditional built-ins when TENEX does not provide equivalents", () => {
                const disallowed = getDisallowedTools(["delegate"], []);
                expect(disallowed).not.toContain("WebFetch");
                expect(disallowed).not.toContain("WebSearch");
            });
        });

        describe("MCP tool pattern matching", () => {
            it("should disable TodoWrite when mcp__*__todo_write is provided", () => {
                const disallowed = getDisallowedTools([], ["mcp__tenex__todo_write"]);
                expect(disallowed).toContain("TodoWrite");
            });

            it("should disable TodoWrite when mcp__*__write_todos is provided", () => {
                const disallowed = getDisallowedTools([], ["mcp__external__write_todos"]);
                expect(disallowed).toContain("TodoWrite");
            });
        });

        describe("full capability agents", () => {
            it("should disable all overlapping built-ins for full-capability agent", () => {
                const disallowed = getDisallowedTools(
                    [...FULL_CAPABILITY_TOOLS],
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
                expect(disallowed).toContain("TaskOutput");
                expect(disallowed).toContain("Task");
                expect(disallowed).toContain("TodoWrite");
            });
        });

        describe("restricted agents", () => {
            it("should disable always-disabled built-ins and mapped tools, allow unmapped conditional built-ins", () => {
                const disallowed = getDisallowedTools(["delegate", "ask", "lesson_learn"], []);

                // Always disabled
                expect(disallowed).toContain("Read");
                expect(disallowed).toContain("Write");
                expect(disallowed).toContain("Edit");
                expect(disallowed).toContain("Glob");
                expect(disallowed).toContain("Grep");
                expect(disallowed).toContain("LS");
                expect(disallowed).toContain("NotebookEdit");
                expect(disallowed).toContain("Bash");
                expect(disallowed).toContain("TaskOutput");

                // delegate is provided, so Task should be disabled
                expect(disallowed).toContain("Task");

                // No web tools provided, so those built-ins should NOT be disabled
                expect(disallowed).not.toContain("WebFetch");
                expect(disallowed).not.toContain("WebSearch");
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

        it("should disable all always-disabled built-ins for any agent", () => {
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
            expect(settings.disallowedTools).toContain("Bash");
            expect(settings.disallowedTools).toContain("TaskOutput");
        });
    });
});
