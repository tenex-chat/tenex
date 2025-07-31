import { PromptBuilder } from "../../core/PromptBuilder";
import "../available-agents";
import "../orchestrator-routing";
import "../agentFragments";
import type { Agent } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import { describe, expect, it } from "bun:test";

describe("Agent Routing Integration", () => {
    const mockAgents: Agent[] = [
        {
            name: "Project Manager",
            pubkey: "pm123",
            role: "Project coordination and planning",
            slug: "pm",
            isOrchestrator: true,
            signer: {} as any,
            llmConfig: "gpt-4",
            tools: ["switch_phase", "handoff"],
        },
        {
            name: "Frontend Developer",
            pubkey: "dev456",
            role: "Frontend development and UI implementation",
            slug: "frontend-dev",
            isOrchestrator: false,
            signer: {} as any,
            llmConfig: "gpt-4",
            tools: ["read_path"],
        },
    ];

    it("should build complete system prompt for regular agent", () => {
        const prompt = new PromptBuilder()
            .add("available-agents", {
                agents: mockAgents,
                currentAgentPubkey: "dev456",
            })
            .build();

        expect(prompt).toContain("## Available Agents");
        expect(prompt).toContain("**Project Manager** (Orchestrator) (pm)");
        expect(prompt).not.toContain("Frontend Developer");
        expect(prompt).toContain("As a Specialist");
    });

    it("should build complete system prompt for orchestrator agent with routing instructions", () => {
        const prompt = new PromptBuilder()
            .add("available-agents", {
                agents: mockAgents,
                currentAgentPubkey: "pm123",
            })
            .add("orchestrator-routing-instructions", {})
            .build();

        // Should have available agents
        expect(prompt).toContain("## Available Agents");
        expect(prompt).toContain("Frontend Developer");
        expect(prompt).not.toContain("Project Manager (PM)");

        // Should have orchestrator routing instructions
        expect(prompt).toContain("## Silent Orchestrator Routing Instructions");
        expect(prompt).toContain("You are a MESSAGE ROUTER");

        // Should have routing rules
        expect(prompt).toContain("ALL new conversations start in CHAT phase");
        expect(prompt).toContain("**Standard flow:** CHAT → PLAN → EXECUTE → VERIFICATION");
    });

    it("should not include identity section for orchestrator agent", () => {
        const orchestratorAgent: Agent = {
            name: "Orchestrator",
            slug: "orchestrator",
            role: "Coordinates complex workflows by delegating tasks to specialized agents.",
            instructions: "You are a message router. Messages are NEVER for you.",
            pubkey: "orchestrator-pubkey",
            signer: {} as any,
            tools: [],
            llmConfig: "orchestrator",
            isOrchestrator: true,
            backend: "routing",
        };

        const prompt = new PromptBuilder()
            .add("agent-system-prompt", {
                agent: orchestratorAgent,
                phase: "CHAT" as Phase,
                projectTitle: "Test Project",
                projectRepository: "test-repo",
            })
            .build();

        // Should NOT have identity section
        expect(prompt).not.toContain("# Your Identity");
        expect(prompt).not.toContain("Your name: Orchestrator");
        expect(prompt).not.toContain("Your role: Coordinates");

        // Should still have instructions and project context
        expect(prompt).toContain("## Your Instructions");
        expect(prompt).toContain("You are a message router");
        expect(prompt).toContain("## Project Context");
        expect(prompt).toContain("Project Name: \"Test Project\"");
    });

    it("should use project name as identity for project-manager agent", () => {
        const projectManagerAgent: Agent = {
            name: "Test Project", // This would be set by AgentRegistry
            slug: "project-manager",
            role: "Project Knowledge Expert",
            instructions: "You are the project knowledge expert.",
            pubkey: "pm-pubkey",
            signer: {} as any,
            tools: [],
            llmConfig: "default",
            isOrchestrator: false,
        };

        const prompt = new PromptBuilder()
            .add("agent-system-prompt", {
                agent: projectManagerAgent,
                phase: "CHAT" as Phase,
                projectTitle: "Test Project",
                projectRepository: "test-repo",
            })
            .build();

        // Should have identity section with project name
        expect(prompt).toContain("# Your Identity");
        expect(prompt).toContain("Your name: Test Project");
        expect(prompt).toContain("Your role: Project Knowledge Expert");

        // Should have instructions and project context
        expect(prompt).toContain("## Your Instructions");
        expect(prompt).toContain("You are the project knowledge expert");
        expect(prompt).toContain("## Project Context");
        expect(prompt).toContain("Project Name: \"Test Project\"");
    });
});
