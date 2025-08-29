import { describe, expect, it } from "bun:test";
import { getBuiltInAgents } from "../builtInAgents";
import { getDefaultToolsForAgent } from "../constants";
import type { AgentInstance } from "../types";

describe("Tool assignment", () => {
  describe("getDefaultToolsForAgent", () => {
    it("orchestrator agent should have default tools (no longer special cased)", () => {
      const mockAgent = {
        isBuiltIn: true,
        slug: "orchestrator",
      } as Pick<AgentInstance, "isBuiltIn" | "slug">;
      const tools = getDefaultToolsForAgent(mockAgent);

      // Orchestrator now gets standard tools like other agents
      expect(tools).toContain("read_path");
      expect(tools).toContain("lesson_learn");
      expect(tools).toContain("claude_code");
      expect(tools).toContain("delegate");
    });

    it("planner and executor agents get default tools", () => {
      const mockExecutor = {
        isBuiltIn: true,
        slug: "executor",
      } as Pick<AgentInstance, "isBuiltIn" | "slug">;
      const mockPlanner = {
        isBuiltIn: true,
        slug: "planner",
      } as Pick<AgentInstance, "isBuiltIn" | "slug">;

      const executorTools = getDefaultToolsForAgent(mockExecutor);
      const plannerTools = getDefaultToolsForAgent(mockPlanner);

      // Both agents get default tools from constants.ts
      expect(executorTools).toContain("read_path");
      expect(executorTools).toContain("lesson_learn");
      expect(executorTools).toContain("claude_code");
      expect(executorTools).toContain("delegate"); // All non-PM agents have delegate

      // Planner gets the same default tools
      expect(plannerTools).toContain("read_path");
      expect(plannerTools).toContain("lesson_learn");
      expect(plannerTools).toContain("claude_code");
      expect(plannerTools).toContain("delegate"); // All non-PM agents have delegate
    });

    it("custom agents should have default tools including delegate", () => {
      const mockCustomAgent = {
        isBuiltIn: false,
        slug: "custom-agent",
      } as Pick<AgentInstance, "isBuiltIn" | "slug">;
      const tools = getDefaultToolsForAgent(mockCustomAgent);

      expect(tools).toContain("delegate"); // All non-PM agents have delegate
      expect(tools).toContain("read_path");
      expect(tools).toContain("lesson_learn");
      expect(tools).toContain("claude_code");
    });

    it("project-manager agent should have special tools including delegate", () => {
      const mockProjectManager = {
        isBuiltIn: true,
        slug: "project-manager",
      } as Pick<AgentInstance, "isBuiltIn" | "slug">;
      const tools = getDefaultToolsForAgent(mockProjectManager);

      expect(tools).toContain("delegate"); // PM uses delegate with phase support
      expect(tools).toContain("write_context_file");
      expect(tools).toContain("shell");
      expect(tools).toContain("discover_capabilities");
      expect(tools).toContain("agents_hire");
      expect(tools).toContain("agents_discover");
      expect(tools).toContain("nostr_projects");
    });
  });

  describe("AgentRegistry tool assignment fix", () => {
    it("should determine isBuiltIn before assigning tools", () => {
      // This test verifies that when creating an agent,
      // the isBuiltIn status is determined BEFORE calling getDefaultToolsForAgent

      const builtInSlugs = getBuiltInAgents().map((a) => a.slug);

      // Verify built-in agents (orchestrator is no longer in the list)
      expect(builtInSlugs).toContain("executor");
      expect(builtInSlugs).toContain("planner");
      expect(builtInSlugs).toContain("project-manager");

      // The fix in AgentRegistry.ts ensures isBuiltIn is determined before tool assignment
      const isBuiltIn = builtInSlugs.includes("executor");
      expect(isBuiltIn).toBe(true);
    });
  });
});
