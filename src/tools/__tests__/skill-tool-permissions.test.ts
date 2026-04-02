import { describe, expect, it } from "bun:test";
import { createMockExecutionEnvironment } from "@/test-utils";
import type { SkillToolPermissions } from "@/services/skill";
import { getToolsObject } from "../registry";
import { CORE_AGENT_TOOLS } from "@/agents/constants";

describe("Skill Tool Permissions", () => {
    const mockContext = createMockExecutionEnvironment();

    describe("skill-provided tool filtering (token savings)", () => {
        it("should filter out shell even when it's in agent's configured tools", () => {
            const baseTools = ["fs_read", "shell", "delegate"];

            const tools = getToolsObject(baseTools, mockContext, undefined);
            const toolNames = Object.keys(tools);

            // shell is skill-provided, should NOT be loaded (saves tokens!)
            expect(toolNames).not.toContain("shell");
            expect(toolNames).toContain("fs_read"); // Core tool, always present
            expect(toolNames).toContain("delegate"); // Not skill-provided
        });

        it("should filter out all RAG tools from agent config", () => {
            const baseTools = ["fs_read", "rag_search", "rag_collection_create"];

            const tools = getToolsObject(baseTools, mockContext, undefined);
            const toolNames = Object.keys(tools);

            // All RAG tools are skill-provided
            expect(toolNames).not.toContain("rag_search");
            expect(toolNames).not.toContain("rag_collection_create");
            expect(toolNames).toContain("fs_read");
        });
    });

    describe("getToolsObject with nudge permissions", () => {
        describe("only-tool mode (highest priority)", () => {
            it("should return EXACTLY the tools specified in onlyTools with NO auto-injection", () => {
                const baseTools = ["fs_read", "fs_write", "agents_write", "delegate"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["fs_read", "fs_write"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Should have EXACTLY the only-tools - NO auto-injection (security feature)
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("fs_write");
                expect(toolNames).not.toContain("fs_edit"); // NO auto-injection in only-tool mode!
                expect(toolNames).not.toContain("agents_write");
                expect(toolNames).not.toContain("delegate");
                expect(toolNames.length).toBe(2); // Exactly 2 tools
            });

            it("should completely ignore allow-tool when only-tool is set", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["agents_write"],
                    allowTools: ["delegate", "fs_write"], // Should be ignored
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("agents_write");
                expect(toolNames).not.toContain("delegate");
                expect(toolNames).not.toContain("fs_read");
            });

            it("should completely ignore deny-tool when only-tool is set", () => {
                const baseTools = ["fs_read", "agents_write", "delegate"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["fs_read", "agents_write"],
                    denyTools: ["fs_read"], // Should be ignored - fs_read should still be included
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("agents_write");
                expect(toolNames).not.toContain("delegate");
            });

            it("should fall back to base tools when onlyTools array is empty", () => {
                const baseTools = ["fs_read", "agents_write"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: [], // Empty array does NOT trigger only-tool mode
                };

                // Empty onlyTools array is NOT treated as only-tool mode (length === 0)
                // This falls back to regular allow/deny processing with base tools
                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Base tools should remain - empty onlyTools doesn't mean "no tools"
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("agents_write");
            });
        });

        describe("allow-tool mode", () => {
            it("should add allowed tools to the base set", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["agents_write", "delegate"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("agents_write");
                expect(toolNames).toContain("delegate");
            });

            it("should not duplicate tools already in base set", () => {
                const baseTools = ["fs_read", "agents_write"];
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["fs_read", "agents_write"], // Already in base
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("agents_write");
                // Core tools are auto-injected when conversation context is present
                expect(toolNames).toContain("kill");
                expect(toolNames).toContain("todo_write");
                // fs_read triggers auto-injection of fs_glob + fs_grep (but they're already core)
                expect(toolNames).toContain("fs_glob");
                expect(toolNames).toContain("fs_grep");
                // All filesystem tools are now core, so no home_fs fallbacks needed
                expect(toolNames).not.toContain("home_fs_write");
                expect(toolNames).not.toContain("home_fs_edit");
                // CORE_AGENT_TOOLS + shell (from baseTools, not core)
                expect(toolNames.length).toBe(CORE_AGENT_TOOLS.length + 1);
            });
        });

        describe("deny-tool mode", () => {
            it("should remove denied tools from the base set", () => {
                const baseTools = ["fs_read", "fs_write", "agents_write", "delegate"];
                const nudgePermissions: SkillToolPermissions = {
                    denyTools: ["agents_write", "delegate"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("fs_write");
                expect(toolNames).not.toContain("agents_write");
                expect(toolNames).not.toContain("delegate");
            });

            it("should handle denying non-existent tools gracefully", () => {
                const baseTools = ["fs_read", "agents_write"];
                const nudgePermissions: SkillToolPermissions = {
                    denyTools: ["non_existent_tool", "another_fake_tool"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Original tools should remain
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("agents_write");
            });

            it("should block auto-injected core tools (kill) when denied", () => {
                const baseTools = ["fs_read", "agents_write"];
                const nudgePermissions: SkillToolPermissions = {
                    denyTools: ["kill"], // Block the auto-injected kill tool
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Core tools should NOT be auto-injected when explicitly denied (SECURITY)
                expect(toolNames).not.toContain("kill");
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("agents_write");
            });
        });

        describe("combined allow and deny", () => {
            it("should apply both allow and deny (add then remove)", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["agents_write", "delegate"],
                    denyTools: ["fs_read"], // Remove the original tool
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).not.toContain("fs_read"); // Denied
                expect(toolNames).toContain("agents_write"); // Allowed
                expect(toolNames).toContain("delegate"); // Allowed
            });

            it("should deny tools even if they were added by allow", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["agents_write", "delegate"],
                    denyTools: ["agents_write"], // Deny something we just allowed
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).not.toContain("agents_write"); // Denied even though allowed
                expect(toolNames).toContain("delegate");
            });
        });

        describe("no nudge permissions", () => {
            it("should return base tools when no permissions provided", () => {
                const baseTools = ["fs_read", "agents_write", "delegate"];

                const tools = getToolsObject(baseTools, mockContext, undefined);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("agents_write");
                expect(toolNames).toContain("delegate");
            });

            it("should return base tools when permissions is empty object", () => {
                const baseTools = ["fs_read", "agents_write"];
                const nudgePermissions: SkillToolPermissions = {};

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("agents_write");
            });
        });

        describe("MCP tool handling", () => {
            it("should filter MCP tools with only-tool mode", () => {
                // MCP tools start with "mcp__"
                const baseTools = ["fs_read", "mcp__tenex__ask"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["fs_read"], // Exclude MCP tool
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).not.toContain("mcp__tenex__ask");
            });

            it("should include MCP tools if specified in only-tool", () => {
                const baseTools = ["fs_read", "mcp__tenex__ask"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["mcp__tenex__ask"], // Only MCP tool
                };

                // Note: MCP tools require mcpManager in context to be loaded
                // Without it, MCP tools won't be included even if requested
                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // MCP tool won't be loaded without mcpManager
                expect(toolNames).not.toContain("mcp__tenex__ask");
                expect(toolNames).not.toContain("fs_read");
            });
        });

        describe("auto-injection behavior", () => {
            it("should NOT auto-inject fs_edit when fs_write is in only-tools (strict exclusivity)", () => {
                const baseTools = ["fs_read", "agents_write"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["fs_write"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_write");
                expect(toolNames).not.toContain("fs_edit"); // NO auto-injection in only-tool mode!
                expect(toolNames).not.toContain("fs_read");
                expect(toolNames).not.toContain("agents_write");
                expect(toolNames.length).toBe(1); // Exactly 1 tool
            });

            it("should auto-inject fs_edit when fs_write is allowed (not only-tool mode)", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: SkillToolPermissions = {
                    allowTools: ["fs_write"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("fs_write");
                expect(toolNames).toContain("fs_edit"); // Auto-injected in allow mode
            });

            it("should auto-inject fs_edit in base tools mode (no nudge permissions)", () => {
                const baseTools = ["fs_read", "fs_write"];

                const tools = getToolsObject(baseTools, mockContext, undefined);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("fs_write");
                expect(toolNames).toContain("fs_edit"); // Auto-injected normally
            });
        });

        describe("only-tool mode strict exclusivity", () => {
            it("should produce exact tool count with no extras", () => {
                const baseTools = ["fs_read", "fs_write", "agents_write", "delegate", "ask"];
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["agents_write", "ask"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Exactly 2 tools, nothing else
                expect(toolNames).toEqual(expect.arrayContaining(["agents_write", "ask"]));
                expect(toolNames.length).toBe(2);
            });


        });

        describe("empty base tools with nudge permissions", () => {
            it("should grant tools via only-tool to agent with empty tools array", () => {
                const baseTools: string[] = []; // Agent has no default tools
                const nudgePermissions: SkillToolPermissions = {
                    onlyTools: ["fs_read", "agents_write"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Nudge grants tools even with empty base
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("agents_write");
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

            it("should return core tools (including fs tools) when no base tools and no nudge permissions", () => {
                const baseTools: string[] = [];

                const tools = getToolsObject(baseTools, mockContext, undefined);
                const toolNames = Object.keys(tools);

                // Core tools are auto-injected when conversation context is present
                expect(toolNames).toContain("kill");
                expect(toolNames).toContain("todo_write");
                // All filesystem tools are now core, so they're included automatically
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("fs_write");
                expect(toolNames).toContain("fs_edit");
                expect(toolNames).toContain("fs_glob");
                expect(toolNames).toContain("fs_grep");
                // Home fs tools are NOT injected since fs_* tools are available as core
                expect(toolNames).not.toContain("home_fs_read");
                expect(toolNames).not.toContain("home_fs_write");
                // Should have exactly CORE_AGENT_TOOLS
                expect(toolNames.length).toBe(CORE_AGENT_TOOLS.length);
            });
        });
    });
});
