import { describe, expect, it } from "bun:test";
import { createMockExecutionEnvironment } from "@/test-utils";
import type { NudgeToolPermissions } from "@/services/nudge";
import { getToolsObject } from "../registry";

describe("Nudge Tool Permissions", () => {
    const mockContext = createMockExecutionEnvironment();

    describe("getToolsObject with nudge permissions", () => {
        describe("only-tool mode (highest priority)", () => {
            it("should return EXACTLY the tools specified in onlyTools with NO auto-injection", () => {
                const baseTools = ["fs_read", "fs_write", "shell", "delegate"];
                const nudgePermissions: NudgeToolPermissions = {
                    onlyTools: ["fs_read", "fs_write"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Should have EXACTLY the only-tools - NO auto-injection (security feature)
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("fs_write");
                expect(toolNames).not.toContain("fs_edit"); // NO auto-injection in only-tool mode!
                expect(toolNames).not.toContain("shell");
                expect(toolNames).not.toContain("delegate");
                expect(toolNames.length).toBe(2); // Exactly 2 tools
            });

            it("should completely ignore allow-tool when only-tool is set", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: NudgeToolPermissions = {
                    onlyTools: ["shell"],
                    allowTools: ["delegate", "fs_write"], // Should be ignored
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("shell");
                expect(toolNames).not.toContain("delegate");
                expect(toolNames).not.toContain("fs_read");
            });

            it("should completely ignore deny-tool when only-tool is set", () => {
                const baseTools = ["fs_read", "shell", "delegate"];
                const nudgePermissions: NudgeToolPermissions = {
                    onlyTools: ["fs_read", "shell"],
                    denyTools: ["fs_read"], // Should be ignored - fs_read should still be included
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("shell");
                expect(toolNames).not.toContain("delegate");
            });

            it("should fall back to base tools when onlyTools array is empty", () => {
                const baseTools = ["fs_read", "shell"];
                const nudgePermissions: NudgeToolPermissions = {
                    onlyTools: [], // Empty array does NOT trigger only-tool mode
                };

                // Empty onlyTools array is NOT treated as only-tool mode (length === 0)
                // This falls back to regular allow/deny processing with base tools
                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Base tools should remain - empty onlyTools doesn't mean "no tools"
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("shell");
            });
        });

        describe("allow-tool mode", () => {
            it("should add allowed tools to the base set", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: NudgeToolPermissions = {
                    allowTools: ["shell", "delegate"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("shell");
                expect(toolNames).toContain("delegate");
            });

            it("should not duplicate tools already in base set", () => {
                const baseTools = ["fs_read", "shell"];
                const nudgePermissions: NudgeToolPermissions = {
                    allowTools: ["fs_read", "shell"], // Already in base
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("shell");
                expect(toolNames.length).toBe(2); // Should not have duplicates
            });
        });

        describe("deny-tool mode", () => {
            it("should remove denied tools from the base set", () => {
                const baseTools = ["fs_read", "fs_write", "shell", "delegate"];
                const nudgePermissions: NudgeToolPermissions = {
                    denyTools: ["shell", "delegate"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("fs_write");
                expect(toolNames).not.toContain("shell");
                expect(toolNames).not.toContain("delegate");
            });

            it("should handle denying non-existent tools gracefully", () => {
                const baseTools = ["fs_read", "shell"];
                const nudgePermissions: NudgeToolPermissions = {
                    denyTools: ["non_existent_tool", "another_fake_tool"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Original tools should remain
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("shell");
            });
        });

        describe("combined allow and deny", () => {
            it("should apply both allow and deny (add then remove)", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: NudgeToolPermissions = {
                    allowTools: ["shell", "delegate"],
                    denyTools: ["fs_read"], // Remove the original tool
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).not.toContain("fs_read"); // Denied
                expect(toolNames).toContain("shell"); // Allowed
                expect(toolNames).toContain("delegate"); // Allowed
            });

            it("should deny tools even if they were added by allow", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: NudgeToolPermissions = {
                    allowTools: ["shell", "delegate"],
                    denyTools: ["shell"], // Deny something we just allowed
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).not.toContain("shell"); // Denied even though allowed
                expect(toolNames).toContain("delegate");
            });
        });

        describe("no nudge permissions", () => {
            it("should return base tools when no permissions provided", () => {
                const baseTools = ["fs_read", "shell", "delegate"];

                const tools = getToolsObject(baseTools, mockContext, undefined);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("shell");
                expect(toolNames).toContain("delegate");
            });

            it("should return base tools when permissions is empty object", () => {
                const baseTools = ["fs_read", "shell"];
                const nudgePermissions: NudgeToolPermissions = {};

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("shell");
            });
        });

        describe("MCP tool handling", () => {
            it("should filter MCP tools with only-tool mode", () => {
                // MCP tools start with "mcp__"
                const baseTools = ["fs_read", "mcp__tenex__ask"];
                const nudgePermissions: NudgeToolPermissions = {
                    onlyTools: ["fs_read"], // Exclude MCP tool
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_read");
                expect(toolNames).not.toContain("mcp__tenex__ask");
            });

            it("should include MCP tools if specified in only-tool", () => {
                const baseTools = ["fs_read", "mcp__tenex__ask"];
                const nudgePermissions: NudgeToolPermissions = {
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
                const baseTools = ["fs_read", "shell"];
                const nudgePermissions: NudgeToolPermissions = {
                    onlyTools: ["fs_write"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                expect(toolNames).toContain("fs_write");
                expect(toolNames).not.toContain("fs_edit"); // NO auto-injection in only-tool mode!
                expect(toolNames).not.toContain("fs_read");
                expect(toolNames).not.toContain("shell");
                expect(toolNames.length).toBe(1); // Exactly 1 tool
            });

            it("should auto-inject fs_edit when fs_write is allowed (not only-tool mode)", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: NudgeToolPermissions = {
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
                const baseTools = ["fs_read", "fs_write", "shell", "delegate", "ask"];
                const nudgePermissions: NudgeToolPermissions = {
                    onlyTools: ["shell", "ask"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Exactly 2 tools, nothing else
                expect(toolNames).toEqual(expect.arrayContaining(["shell", "ask"]));
                expect(toolNames.length).toBe(2);
            });

            it("should not include alpha tools even if context has alphaMode", () => {
                const baseTools = ["fs_read"];
                const nudgePermissions: NudgeToolPermissions = {
                    onlyTools: ["fs_read"],
                };

                // Create context with alphaMode enabled
                const contextWithAlpha = { ...mockContext, alphaMode: true };
                const tools = getToolsObject(baseTools, contextWithAlpha, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Should ONLY have fs_read, no alpha tools
                expect(toolNames).toEqual(["fs_read"]);
                expect(toolNames).not.toContain("bug_list");
                expect(toolNames).not.toContain("bug_report_create");
                expect(toolNames).not.toContain("bug_report_add");
            });
        });

        describe("empty base tools with nudge permissions", () => {
            it("should grant tools via only-tool to agent with empty tools array", () => {
                const baseTools: string[] = []; // Agent has no default tools
                const nudgePermissions: NudgeToolPermissions = {
                    onlyTools: ["fs_read", "shell"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Nudge grants tools even with empty base
                expect(toolNames).toContain("fs_read");
                expect(toolNames).toContain("shell");
                expect(toolNames.length).toBe(2);
            });

            it("should grant tools via allow-tool to agent with empty tools array", () => {
                const baseTools: string[] = []; // Agent has no default tools
                const nudgePermissions: NudgeToolPermissions = {
                    allowTools: ["delegate", "ask"],
                };

                const tools = getToolsObject(baseTools, mockContext, nudgePermissions);
                const toolNames = Object.keys(tools);

                // Nudge adds tools to empty base
                expect(toolNames).toContain("delegate");
                expect(toolNames).toContain("ask");
            });

            it("should return empty when no base tools and no nudge permissions", () => {
                const baseTools: string[] = [];

                const tools = getToolsObject(baseTools, mockContext, undefined);
                const toolNames = Object.keys(tools);

                expect(toolNames.length).toBe(0);
            });
        });
    });
});
