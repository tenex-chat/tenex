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

      // All agents now get the same comprehensive tool set
      expect(tools).toContain("read_path");
      expect(tools).toContain("lesson_learn");
      expect(tools).toContain("claude_code");
      expect(tools).toContain("delegate");
      expect(tools).toContain("delegate_phase");
      expect(tools).toContain("write_context_file");
      expect(tools).toContain("shell");
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
      
      // Verify they all have core tools
      [tools1, tools2, tools3].forEach(tools => {
        expect(tools).toContain("read_path");
        expect(tools).toContain("lesson_learn");
        expect(tools).toContain("claude_code");
        expect(tools).toContain("delegate");
      });
    });

    it("tools should include both delegate and delegate_phase", () => {
      const mockAgent = {
        slug: "test-agent",
      } as Pick<AgentInstance, "slug">;
      const tools = getDefaultToolsForAgent(mockAgent);

      // All agents now have access to both delegation mechanisms
      expect(tools).toContain("delegate");
      expect(tools).toContain("delegate_phase");
      expect(tools).toContain("delegate_external");
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
      const toolSets = allAgents.map(slug => 
        getDefaultToolsForAgent({ slug } as Pick<AgentInstance, "slug">)
      );
      
      // All should be identical
      const firstSet = toolSets[0];
      toolSets.forEach(set => {
        expect(set).toEqual(firstSet);
      });
    });
  });
});
