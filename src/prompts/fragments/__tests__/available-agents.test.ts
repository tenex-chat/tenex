import { PromptBuilder } from "../../core/PromptBuilder";
import "../available-agents"; // Ensure fragment is registered
import type { Agent } from "@/agents/types";

describe("Available Agents Fragment", () => {
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
        {
            name: "Backend Developer",
            pubkey: "backend789",
            role: "Backend development and API implementation",
            slug: "backend-dev",
            signer: {} as any,
            llmConfig: "gpt-4",
            tools: ["read_path", "claude_code"],
        },
    ];

    it("should generate available agents list for all agents", () => {
        const prompt = new PromptBuilder()
            .add("available-agents", {
                agents: mockAgents,
            })
            .build();

        expect(prompt).toContain("## Available Agents");
        expect(prompt).toContain("**Project Manager** (Orchestrator)");
        expect(prompt).toContain("Frontend Developer");
        expect(prompt).toContain("Backend Developer");
    });

    it("should exclude current agent from handoff options", () => {
        const prompt = new PromptBuilder()
            .add("available-agents", {
                agents: mockAgents,
                currentAgentPubkey: "dev456",
            })
            .build();

        expect(prompt).toContain("## Available Agents");
        expect(prompt).toContain("**Project Manager** (Orchestrator)");
        expect(prompt).not.toContain("Frontend Developer");
        expect(prompt).toContain("Backend Developer");
    });

    it("should handle empty agents list", () => {
        const prompt = new PromptBuilder()
            .add("available-agents", {
                agents: [],
            })
            .build();

        expect(prompt).toContain("No agents are currently available");
    });

    it("should handle case where only current agent exists", () => {
        const prompt = new PromptBuilder()
            .add("available-agents", {
                agents: [mockAgents[0]],
                currentAgentPubkey: "pm123",
            })
            .build();

        expect(prompt).toContain("No other agents are available");
    });

    it("should provide orchestrator-specific guidance for orchestrator agents", () => {
        const prompt = new PromptBuilder()
            .add("available-agents", {
                agents: mockAgents,
                currentAgentPubkey: "pm123", // Orchestrator agent
            })
            .build();

        expect(prompt).toContain("As Orchestrator");
        expect(prompt).toContain("delegate using the continue tool");
        expect(prompt).toContain("Only the Executor can modify the system");
    });

    it("should provide specialist-specific guidance for non-orchestrator agents", () => {
        const prompt = new PromptBuilder()
            .add("available-agents", {
                agents: mockAgents,
                currentAgentPubkey: "dev456", // Specialist agent
            })
            .build();

        expect(prompt).toContain("As a Specialist/Expert");
        expect(prompt).toContain("You CANNOT modify files or system state");
        expect(prompt).toContain("Your advice will be implemented by the Executor agent");
    });
});
