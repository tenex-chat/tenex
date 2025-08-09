import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../systemPromptBuilder";
import type { AgentInstance } from "@/agents/types";
import { PHASES } from "@/conversations/phases";
// Import all required fragments
import "@/prompts/fragments/agentFragments";
import "@/prompts/fragments/available-agents";
import "@/prompts/fragments/project";
import "@/prompts/fragments/phase";
import "@/prompts/fragments/retrieved-lessons";
import "@/prompts/fragments/mcp-tools";
import "@/prompts/fragments/tool-use";
import "@/prompts/fragments/orchestrator-routing";
import "@/prompts/fragments/expertise-boundaries";
import "@/prompts/fragments/agent-tools";
import "@/prompts/fragments/agent-reasoning";

describe("systemPromptBuilder with yield-back", () => {
    const baseAgent: Agent = {
        id: "test-agent",
        pubkey: "test-pubkey",
        name: "Test Agent",
        role: "Test Role",
        tools: [],
    };

    it("should include yield-back fragment for non-orchestrator agents", () => {
        const systemPrompt = buildSystemPrompt({
            agent: { ...baseAgent, isOrchestrator: false },
            phase: PHASES.EXECUTE,
            projectTitle: "Test Project",
        });

        expect(systemPrompt).toContain("When to use complete() tool");
        expect(systemPrompt).toContain("complete");
        expect(systemPrompt).toContain("orchestrator");
    });

    it("should NOT include yield-back fragment for orchestrator agents", () => {
        const systemPrompt = buildSystemPrompt({
            agent: { ...baseAgent, isOrchestrator: true },
            phase: PHASES.EXECUTE,
            projectTitle: "Test Project",
        });

        // Orchestrator should not have the yield-back fragment section
        expect(systemPrompt).not.toContain("When to use complete() tool");
        expect(systemPrompt).not.toContain("When NOT to use complete()");
    });

    it("should include yield-back for custom non-orchestrator agents", () => {
        const customAgent: Agent = {
            ...baseAgent,
            name: "Custom Agent",
            role: "Custom Role",
            isOrchestrator: false,
        };

        const systemPrompt = buildSystemPrompt({
            agent: customAgent,
            phase: PHASES.EXECUTE,
            projectTitle: "Test Project",
        });

        expect(systemPrompt).toContain("When to use complete() tool");
        expect(systemPrompt).toContain("complete");
        expect(systemPrompt).toContain("orchestrator");
    });
});
