import { describe, expect, it } from "bun:test";
import { createMockExecutionEnvironment } from "@/test-utils";
import type { SkillToolPermissions } from "@/services/skill";
import { getToolsObject } from "../registry";
import { CORE_AGENT_TOOLS } from "@/agents/constants";

describe("Skill Tool Permissions", () => {
    const mockContext = createMockExecutionEnvironment();

    describe("skill-provided tool filtering (token savings)", () => {
        it("should filter out shell even when it's in agent's configured tools", () => {
            const baseTools = ["shell", "delegate"];

            const tools = getToolsObject(baseTools, mockContext, undefined);
            const toolNames = Object.keys(tools);

            // shell is skill-provided, should NOT be loaded (saves tokens!)
            expect(toolNames).not.toContain("shell");
            expect(toolNames).toContain("delegate"); // Not skill-provided
        });

        it("should filter out all RAG tools from agent config", () => {
            const baseTools = ["ask", "rag_search", "rag_collection_create"];

            const tools = getToolsObject(baseTools, mockContext, undefined);
            const toolNames = Object.keys(tools);

            // All RAG tools are skill-provided
            expect(toolNames).not.toContain("rag_search");
            expect(toolNames).not.toContain("rag_collection_create");
            expect(toolNames).toContain("ask");
        });
    });

    describe("getToolsObject with nudge permissions", () => {
        describe("only-tool mode (highest priority)", () => {
            it("should return EXACTLY the tools specified in onlyTools with NO auto-injection", () => {
                const baseTools = ["ask", "kill", "delegate_crossproject", "delegate"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["ask", "kill"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Should have EXACTLY the only-tools - NO auto-injection (security feature)
                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("kill");
                expect(toolNames).not.toContain("delegate_crossproject");
                expect(toolNames).not.toContain("delegate");
                expect(toolNames.length).toBe(2); // Exactly 2 tools
            });

            it("should completely ignore allow-tool when only-tool is set", () => {
                const baseTools = ["ask"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["delegate_crossproject"],
                    allowTools: ["delegate", "kill"], // Should be ignored
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("delegate_crossproject");
                expect(toolNames).not.toContain("delegate");
                expect(toolNames).not.toContain("ask");
            });

            it("should completely ignore deny-tool when only-tool is set", () => {
                const baseTools = ["ask", "delegate_crossproject", "delegate"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["ask", "delegate_crossproject"],
                    denyTools: ["ask"], // Should be ignored - ask should still be included
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("delegate_crossproject");
                expect(toolNames).not.toContain("delegate");
            });

            it("should fall back to base tools when onlyTools array is empty", () => {
                const baseTools = ["ask", "delegate_crossproject"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: [], // Empty array does NOT trigger only-tool mode
                };

                // Empty onlyTools array is NOT treated as only-tool mode (length === 0)
                // This falls back to regular allow/deny processing with base tools
                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Base tools should remain - empty onlyTools doesn't mean "no tools"
                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("delegate_crossproject");
            });
        });

        describe("allow-tool mode", () => {
            it("should add allowed tools to the base set", () => {
                const baseTools = ["ask"];
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["delegate_crossproject", "delegate"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("delegate_crossproject");
                expect(toolNames).toContain("delegate");
            });

            it("should not duplicate tools already in base set", () => {
                const baseTools = ["ask", "delegate_crossproject"];
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["ask", "delegate_crossproject"], // Already in base
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("delegate_crossproject");
                // Core tools are auto-injected when conversation context is present
                expect(toolNames).toContain("kill");
                expect(toolNames).toContain("todo_write");
                // home_fs_* tools are auto-injected when fs_* tools are not available
                expect(toolNames).toContain("home_fs_read");
                expect(toolNames).toContain("home_fs_write");
                expect(toolNames).toContain("home_fs_edit");
                expect(toolNames).toContain("home_fs_glob");
                expect(toolNames).toContain("home_fs_grep");
                // CORE_AGENT_TOOLS + ask + delegate_crossproject + home_fs_* (5 tools)
                expect(toolNames.length).toBe(CORE_AGENT_TOOLS.length + 2 + 5);
            });
        });

        describe("deny-tool mode", () => {
            it("should remove denied tools from the base set", () => {
                const baseTools = ["ask", "kill", "delegate_crossproject", "delegate"];
                const nudgePermissions: SkillToolPermissions = {
                    denyTools: ["delegate_crossproject", "delegate"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("kill");
                expect(toolNames).not.toContain("delegate_crossproject");
                expect(toolNames).not.toContain("delegate");
            });

            it("should handle denying non-existent tools gracefully", () => {
                const baseTools = ["ask", "delegate_crossproject"];
                const nudgePermissions: SkillToolPermissions = {
                    denyTools: ["non_existent_tool", "another_fake_tool"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Original tools should remain
                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("delegate_crossproject");
            });

            it("should block auto-injected core tools (kill) when denied", () => {
                const baseTools = ["ask", "delegate_crossproject"];
                const nudgePermissions: SkillToolPermissions = {
                    denyTools: ["kill"], // Block the auto-injected kill tool
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Core tools should NOT be auto-injected when explicitly denied (SECURITY)
                expect(toolNames).not.toContain("kill");
                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("delegate_crossproject");
            });
        });

        describe("combined allow and deny", () => {
            it("should apply both allow and deny (add then remove)", () => {
                const baseTools = ["ask"];
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["delegate_crossproject", "delegate"],
                    denyTools: ["ask"], // Remove the original tool
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).not.toContain("ask"); // Denied
                expect(toolNames).toContain("delegate_crossproject"); // Allowed
                expect(toolNames).toContain("delegate"); // Allowed
            });

            it("should deny tools even if they were added by allow", () => {
                const baseTools = ["ask"];
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["delegate_crossproject", "delegate"],
                    denyTools: ["delegate_crossproject"], // Deny something we just allowed
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("ask");
                expect(toolNames).not.toContain("delegate_crossproject"); // Denied even though allowed
                expect(toolNames).toContain("delegate");
            });
        });

        describe("no nudge permissions", () => {
            it("should return base tools when no permissions provided", () => {
                const baseTools = ["ask", "delegate_crossproject", "delegate"];

                const tools = getToolsObject(baseTools, mockContext, undefined);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("delegate_crossproject");
                expect(toolNames).toContain("delegate");
            });

            it("should return base tools when permissions is empty object", () => {
                const baseTools = ["ask", "delegate_crossproject"];
                const nudgePermissions: SkillToolPermissions = {};

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("delegate_crossproject");
            });
        });

        describe("MCP tool handling", () => {
            it("should filter MCP tools with only-tool mode", () => {
                // MCP tools start with "mcp__"
                const baseTools = ["ask", "mcp__tenex__ask"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["ask"], // Exclude MCP tool
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("ask");
                expect(toolNames).not.toContain("mcp__tenex__ask");
            });

            it("should include MCP tools if specified in only-tool", () => {
                const baseTools = ["ask", "mcp__tenex__ask"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["mcp__tenex__ask"], // Only MCP tool
                };

                // Note: MCP tools require mcpManager in context to be loaded
                // Without it, MCP tools won't be included even if requested
                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // MCP tool won't be loaded without mcpManager
                expect(toolNames).not.toContain("mcp__tenex__ask");
                expect(toolNames).not.toContain("ask");
            });
        });

        describe("only-tool mode strict exclusivity", () => {
            it("should produce exact tool count with no extras", () => {
                const baseTools = ["ask", "kill", "delegate_crossproject", "delegate", "lesson_learn"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["delegate_crossproject", "ask"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Exactly 2 tools, nothing else
                expect(toolNames).toEqual(expect.arrayContaining(["delegate_crossproject", "ask"]));
                expect(toolNames.length).toBe(2);
            });
        });

        describe("empty base tools with nudge permissions", () => {
            it("should grant tools via only-tool to agent with empty tools array", () => {
                const baseTools: string[] = []; // Agent has no default tools
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["ask", "delegate_crossproject"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Nudge grants tools even with empty base
                expect(toolNames).toContain("ask");
                expect(toolNames).toContain("delegate_crossproject");
                expect(toolNames.length).toBe(2);
            });

            it("should grant tools via allow-tool to agent with empty tools array", () => {
                const baseTools: string[] = []; // Agent has no default tools
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["delegate", "ask"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Nudge adds tools to empty base
                expect(toolNames).toContain("delegate");
                expect(toolNames).toContain("ask");
            });

            it("should return core tools when no base tools and no nudge permissions", () => {
                const baseTools: string[] = [];

                const tools = getToolsObject(baseTools, mockContext, undefined);
                const toolNames = Object.keys(tools);

                // Core tools are auto-injected when conversation context is present
                expect(toolNames).toContain("kill");
                expect(toolNames).toContain("todo_write");
                expect(toolNames).toContain("lesson_learn");
                expect(toolNames).toContain("skills_set");
                // Filesystem tools are no longer core — they're skill-provided
                expect(toolNames).not.toContain("fs_read");
                expect(toolNames).not.toContain("fs_write");
                // home_fs_* tools are auto-injected as fallbacks when fs_* tools are not available
                expect(toolNames).toContain("home_fs_read");
                expect(toolNames).toContain("home_fs_write");
                expect(toolNames).toContain("home_fs_edit");
                expect(toolNames).toContain("home_fs_glob");
                expect(toolNames).toContain("home_fs_grep");
                // Should have CORE_AGENT_TOOLS + home_fs_* (5 tools)
                expect(toolNames.length).toBe(CORE_AGENT_TOOLS.length + 5);
            });
        });
    });

    describe("home_fs_* auto-injection", () => {
        it("should always auto-inject all home_fs_* tools from registry", () => {
            const baseTools = ["ask", "delegate"];
            const tools = getToolsObject(baseTools, mockContext, undefined);
            const toolNames = Object.keys(tools);

            // home_fs_* tools are always injected by the registry (they're removed later by StreamSetup if fs_* tools are loaded via skills)
            expect(toolNames).toContain("home_fs_read");
            expect(toolNames).toContain("home_fs_write");
            expect(toolNames).toContain("home_fs_edit");
            expect(toolNames).toContain("home_fs_glob");
            expect(toolNames).toContain("home_fs_grep");
        });

        it("should include home_fs_* tools even with other tools present", () => {
            const baseTools = ["ask", "delegate", "kill"];
            const tools = getToolsObject(baseTools, mockContext, undefined);
            const toolNames = Object.keys(tools);

            expect(toolNames).toContain("home_fs_read");
            expect(toolNames).toContain("home_fs_write");
            expect(toolNames).toContain("home_fs_edit");
            expect(toolNames).toContain("home_fs_glob");
            expect(toolNames).toContain("home_fs_grep");
        });

        it("should respect deny-tool for home_fs_* tools", () => {
            const baseTools = ["ask", "delegate"];
            const nudgePermissions: SkillToolPermissions = {
                denyTools: ["home_fs_write", "home_fs_edit"],
            };

            const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
            const toolNames = Object.keys(tools);

            expect(toolNames).toContain("home_fs_read");
            expect(toolNames).not.toContain("home_fs_write");
            expect(toolNames).not.toContain("home_fs_edit");
            expect(toolNames).toContain("home_fs_glob");
            expect(toolNames).toContain("home_fs_grep");
        });
    });
});
