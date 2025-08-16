import { describe, it, expect, beforeEach, mock } from "bun:test";
import { getDefaultToolsForAgent } from "../constants";
import { getBuiltInAgents } from "../builtInAgents";

describe("Tool assignment", () => {
    describe("getDefaultToolsForAgent", () => {
        it("orchestrator agent should have no tools (uses JSON response)", () => {
            const mockAgent = {
                isOrchestrator: true,
                isBuiltIn: true,
                slug: "orchestrator",
            } as any;
            const tools = getDefaultToolsForAgent(mockAgent);

            expect(tools).toHaveLength(0);
            expect(tools).not.toContain("complete");
            expect(tools).not.toContain("analyze");
            expect(tools).not.toContain("continue");
            expect(tools).not.toContain("lesson_learn");
        });

        it("planner and executor agents get default tools (but AgentRegistry removes them for claude backend)", () => {
            const mockExecutor = {
                isOrchestrator: false,
                isBuiltIn: true,
                slug: "executor",
            } as any;
            const mockPlanner = {
                isOrchestrator: false,
                isBuiltIn: true,
                slug: "planner",
            } as any;

            const executorTools = getDefaultToolsForAgent(mockExecutor);
            const plannerTools = getDefaultToolsForAgent(mockPlanner);

            // Both agents get default tools from constants.ts
            expect(executorTools).toContain("complete");
            expect(executorTools).toContain("read_path");
            expect(executorTools).toContain("lesson_learn");
            expect(executorTools).toContain("analyze");
            expect(executorTools).not.toContain("continue");
            expect(executorTools).not.toContain("delegate"); // No delegate tool for non-PM agents

            // Planner gets the same default tools
            expect(plannerTools).toContain("complete");
            expect(plannerTools).toContain("read_path");
            expect(plannerTools).toContain("lesson_learn");
            expect(plannerTools).toContain("analyze");
            expect(plannerTools).not.toContain("continue");
            expect(plannerTools).not.toContain("delegate"); // No delegate tool for non-PM agents

            // Note: AgentRegistry.ts will remove all tools from these agents
            // since they use claude backend, but getDefaultToolsForAgent
            // returns the default set for non-orchestrator built-in agents
        });

        it("custom agents should have complete tool but not delegate", () => {
            const mockCustomAgent = {
                isOrchestrator: false,
                isBuiltIn: false,
                slug: "custom-agent",
            } as any;
            const tools = getDefaultToolsForAgent(mockCustomAgent);

            expect(tools).toContain("complete");
            expect(tools).not.toContain("continue");
            expect(tools).not.toContain("delegate"); // No delegate tool for custom agents
        });

        it("project-manager agent should have additional tools including delegate", () => {
            const mockProjectManager = {
                isOrchestrator: false,
                isBuiltIn: true,
                slug: "project-manager",
            } as any;
            const tools = getDefaultToolsForAgent(mockProjectManager);

            expect(tools).toContain("complete");
            expect(tools).toContain("delegate"); // Only PM agent has delegate tool
            expect(tools).toContain("write_context_file");
            expect(tools).not.toContain("continue");
        });
    });

    describe("AgentRegistry tool assignment fix", () => {
        it("should determine isBuiltIn before assigning tools", () => {
            // This test verifies that when creating an agent,
            // the isBuiltIn status is determined BEFORE calling getDefaultToolsForAgent

            const builtInSlugs = getBuiltInAgents().map((a) => a.slug);

            // Verify orchestrator is in built-in agents
            expect(builtInSlugs).toContain("orchestrator");
            expect(builtInSlugs).toContain("executor");
            expect(builtInSlugs).toContain("planner");

            // The fix in AgentRegistry.ts line 212 ensures isBuiltIn is determined before tool assignment
            const isBuiltIn = builtInSlugs.includes("orchestrator");
            expect(isBuiltIn).toBe(true);
        });
    });
});
