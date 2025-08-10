import { describe, it, expect } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import { agentToolsFragment } from "../agent-tools";
import { lessonLearnTool } from "@/tools/implementations/learn";

describe("agentToolsFragment", () => {
    it("should generate tool documentation including promptFragment", () => {
        const mockAgent: Agent = {
            name: "Test Agent",
            pubkey: "test-pubkey",
            slug: "test-agent",
            role: "Test Role",
            description: "Test Description",
            tools: [lessonLearnTool],
            isOrchestrator: false,
        } as Agent;

        const result = agentToolsFragment.template({ agent: mockAgent });

        // Check that the result contains the tool name and description
        expect(result).toContain("## Available Agent Tools");
        expect(result).toContain("### lesson_learn");
        expect(result).toContain("Record an important lesson learned during execution");

        // Check that the promptFragment is included
        expect(result).toContain(
            "When you encounter important insights or lessons during your work"
        );
        expect(result).toContain(
            "Domain Boundaries: Only record lessons within your role's sphere of control"
        );
    });

    it("should return empty string when agent has no tools", () => {
        const mockAgent: Agent = {
            name: "Test Agent",
            pubkey: "test-pubkey",
            slug: "test-agent",
            role: "Test Role",
            description: "Test Description",
            tools: [],
            isOrchestrator: false,
        } as Agent;

        const result = agentToolsFragment.template({ agent: mockAgent });
        expect(result).toBe("");
    });
});
