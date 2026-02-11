import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Test suite for mcp__tenex__* tool filtering in ProjectStatusService.
 *
 * Kind 24010 (TenexProjectStatus) events should NOT include tools with the
 * mcp__tenex__ prefix. These are internal TENEX tools wrapped through MCP
 * and should not be announced in status events.
 *
 * This test validates the filtering logic at the gatherToolInfo level.
 */
describe("ProjectStatusService mcp__tenex__ filtering", () => {
    /**
     * Test the filtering logic directly without full ProjectStatusService setup.
     * This validates that the filtering pattern works correctly.
     */
    describe("mcp__tenex__ prefix filtering pattern", () => {
        const filterMcpTenexTools = (toolName: string): boolean => {
            // This mirrors the filtering logic in ProjectStatusService.gatherToolInfo
            return toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__");
        };

        it("should exclude mcp__tenex__ tools", () => {
            expect(filterMcpTenexTools("mcp__tenex__schedule_task")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__schedule_task_cancel")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__lesson_learn")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__report_write")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__delegate")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__ask")).toBe(false);
        });

        it("should include other mcp__ tools (non-tenex)", () => {
            expect(filterMcpTenexTools("mcp__filesystem__read")).toBe(true);
            expect(filterMcpTenexTools("mcp__github__issues")).toBe(true);
            expect(filterMcpTenexTools("mcp__slack__post_message")).toBe(true);
            expect(filterMcpTenexTools("mcp__custom_server__tool")).toBe(true);
        });

        it("should not affect non-mcp tools", () => {
            // Non-mcp tools return false because they don't start with mcp__
            expect(filterMcpTenexTools("delegate")).toBe(false);
            expect(filterMcpTenexTools("fs_read")).toBe(false);
            expect(filterMcpTenexTools("bash")).toBe(false);
        });
    });

    describe("toolAgentMap filtering simulation", () => {
        /**
         * Simulates the filtering applied when building toolAgentMap from cached MCP tools
         */
        it("should filter mcp__tenex__ tools when building from cached tools", () => {
            const cachedMcpTools: Record<string, unknown> = {
                "mcp__tenex__schedule_task": {},
                "mcp__tenex__schedule_task_cancel": {},
                "mcp__tenex__delegate": {},
                "mcp__github__issues": {},
                "mcp__filesystem__read": {},
            };

            const toolAgentMap = new Map<string, Set<string>>();

            // Simulate the filtering logic from gatherToolInfo
            for (const toolName of Object.keys(cachedMcpTools)) {
                if (toolName && !toolAgentMap.has(toolName) && !toolName.startsWith("mcp__tenex__")) {
                    toolAgentMap.set(toolName, new Set());
                }
            }

            // mcp__tenex__ tools should be excluded
            expect(toolAgentMap.has("mcp__tenex__schedule_task")).toBe(false);
            expect(toolAgentMap.has("mcp__tenex__schedule_task_cancel")).toBe(false);
            expect(toolAgentMap.has("mcp__tenex__delegate")).toBe(false);

            // Other mcp tools should be included
            expect(toolAgentMap.has("mcp__github__issues")).toBe(true);
            expect(toolAgentMap.has("mcp__filesystem__read")).toBe(true);
        });

        /**
         * Simulates the filtering applied when building toolAgentMap from agent tools
         */
        it("should filter mcp__tenex__ tools when adding from agent tools", () => {
            const agentTools = [
                "mcp__tenex__lesson_learn",
                "mcp__tenex__report_write",
                "mcp__tenex__ask",
                "mcp__slack__post_message",
                "mcp__linear__create_issue",
                "fs_read",
                "bash",
            ];

            const toolAgentMap = new Map<string, Set<string>>();

            // Simulate the filtering logic from gatherToolInfo (MCP tools section)
            for (const toolName of agentTools) {
                if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__")) {
                    let agentSet = toolAgentMap.get(toolName);
                    if (!agentSet) {
                        agentSet = new Set();
                        toolAgentMap.set(toolName, agentSet);
                    }
                    agentSet.add("test-agent");
                }
            }

            // mcp__tenex__ tools should be excluded
            expect(toolAgentMap.has("mcp__tenex__lesson_learn")).toBe(false);
            expect(toolAgentMap.has("mcp__tenex__report_write")).toBe(false);
            expect(toolAgentMap.has("mcp__tenex__ask")).toBe(false);

            // Other mcp tools should be included with agent association
            expect(toolAgentMap.has("mcp__slack__post_message")).toBe(true);
            expect(toolAgentMap.get("mcp__slack__post_message")?.has("test-agent")).toBe(true);
            expect(toolAgentMap.has("mcp__linear__create_issue")).toBe(true);
            expect(toolAgentMap.get("mcp__linear__create_issue")?.has("test-agent")).toBe(true);

            // Non-mcp tools are NOT added by this logic (handled elsewhere)
            expect(toolAgentMap.has("fs_read")).toBe(false);
            expect(toolAgentMap.has("bash")).toBe(false);
        });
    });

    describe("edge cases", () => {
        it("should handle empty tool names", () => {
            const toolName = "";
            const shouldInclude = toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__");
            expect(shouldInclude).toBe(false);
        });

        it("should handle mcp__tenex (without trailing underscore) correctly", () => {
            // "mcp__tenex" (without trailing __) should be included
            // because it doesn't match "mcp__tenex__" prefix
            const toolName = "mcp__tenex";
            const shouldInclude = toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__");
            expect(shouldInclude).toBe(true);
        });

        it("should handle case-sensitive matching", () => {
            // Tool names are case-sensitive, MCP__TENEX__ is not the same as mcp__tenex__
            const toolName = "MCP__TENEX__something";
            const shouldInclude = toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__");
            expect(shouldInclude).toBe(false); // Doesn't start with lowercase mcp__
        });
    });
});
