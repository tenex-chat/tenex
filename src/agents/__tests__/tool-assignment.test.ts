import { describe, expect, it } from "bun:test";
import { getDefaultToolsForAgent } from "../constants";
import type { AgentInstance } from "../types";

describe("Tool assignment", () => {
    describe("getDefaultToolsForAgent", () => {
        it("all agents should receive the same default tool set", () => {
            const mockAgent = {
                slug: "any-agent",
            } as Pick<AgentInstance, "slug">;
            const tools = getDefaultToolsForAgent(mockAgent);

            // All agents get the same default tool set (delegate tools are added separately)
            expect(tools).toContain("read_path");
            expect(tools).toContain("lesson_learn");
            expect(tools).toContain("claude_code");
            expect(tools).toContain("shell");
            // Delegate tools are NOT in defaults, they're added by getDelegateToolsForAgent
            expect(tools).not.toContain("delegate");
            expect(tools).not.toContain("delegate_phase");
        });

        it("different agents should get identical default tools", () => {
            const agent1 = { slug: "agent-one" } as Pick<AgentInstance, "slug">;
            const agent2 = { slug: "agent-two" } as Pick<AgentInstance, "slug">;
            const agent3 = { slug: "agent-three" } as Pick<AgentInstance, "slug">;

            const tools1 = getDefaultToolsForAgent(agent1);
            const tools2 = getDefaultToolsForAgent(agent2);
            const tools3 = getDefaultToolsForAgent(agent3);

            // All agents get identical tool sets
            expect(tools1).toEqual(tools2);
            expect(tools2).toEqual(tools3);

            // Verify they all have core tools (delegate tools are added separately)
            [tools1, tools2, tools3].forEach((tools) => {
                expect(tools).toContain("read_path");
                expect(tools).toContain("lesson_learn");
                expect(tools).toContain("claude_code");
                // Delegate tools are NOT in defaults
                expect(tools).not.toContain("delegate");
            });
        });

        it("default tools should NOT include delegate tools", () => {
            const mockAgent = {
                slug: "test-agent",
            } as Pick<AgentInstance, "slug">;
            const tools = getDefaultToolsForAgent(mockAgent);

            // Delegate tools are NOT in the default set
            // They're added separately via getDelegateToolsForAgent
            expect(tools).not.toContain("delegate");
            expect(tools).not.toContain("delegate_phase");
            expect(tools).not.toContain("delegate_external");
            expect(tools).not.toContain("delegate_followup");
        });

        it("all agents should have access to agent management tools", () => {
            const mockAgent = {
                slug: "any-agent",
            } as Pick<AgentInstance, "slug">;
            const tools = getDefaultToolsForAgent(mockAgent);

            // Agent management tools available to all
            expect(tools).toContain("agents_hire");
            expect(tools).toContain("agents_discover");
            expect(tools).toContain("discover_capabilities");
            expect(tools).toContain("nostr_projects");
        });
    });

    describe("Tool assignment behavior", () => {
        it("should provide consistent tools regardless of agent slug", () => {
            // Test that the tool assignment is now uniform
            const specialNames = ["project-manager", "executor", "planner", "orchestrator"];
            const normalNames = ["custom-agent", "my-agent", "test-agent"];

            const allAgents = [...specialNames, ...normalNames];
            const toolSets = allAgents.map((slug) =>
                getDefaultToolsForAgent({ slug } as Pick<AgentInstance, "slug">)
            );

            // All should be identical
            const firstSet = toolSets[0];
            toolSets.forEach((set) => {
                expect(set).toEqual(firstSet);
            });
        });
    });
});
