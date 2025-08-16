import { describe, expect, it } from "bun:test";
import {
    orchestratorRoutingInstructionsFragment,
} from "../25-orchestrator-routing";

describe("Orchestrator Routing - Clarity-Based Decision Making", () => {
    it("should contain request clarity assessment instructions", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Phase Starting Points");
        expect(result).toContain("Clear, specific requests: Start directly in EXECUTE");
        expect(result).toContain("Complex but clear tasks: Start in PLAN");
        expect(result).toContain("Unclear requirements: Start in CHAT");
    });

    it("should specify clarity-based routing actions", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        // Check phase selection table
        expect(result).toContain("Phase Selection Table");
        expect(result).toContain("Clear action verbs, specific requests");
        expect(result).toContain("Complex architecture needed");
        expect(result).toContain("Ambiguous, needs clarification");
        expect(result).toContain("project-manager");
    });

    it("should contain agent restriction rules", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("CRITICAL AGENT RESTRICTION RULES");
        expect(result).toContain("planner agent**: Use ONLY in");
        expect(result).toContain("executor agent**: Use ONLY in");
        expect(result).toContain(
            "NEVER delegate verification, chores, reflection"
        );
    });

    it("should specify proper agent usage per phase", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Agent Capabilities");
        expect(result).toContain("EXECUTE phase ONLY - never for verification/chores/reflection");
        expect(result).toContain("PLAN phase ONLY - never for verification/chores/reflection");
        expect(result).toContain("project-manager or domain experts (NEVER planner/executor)");
    });

    it("should enforce mandatory post-execute phases", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain(
            "After execution work, you MUST proceed through VERIFICATION → CHORES → REFLECTION"
        );
        expect(result).toContain("Standard flow");
        expect(result).toContain("VERIFICATION");
        expect(result).toContain("CHORES");
        expect(result).toContain("REFLECTION");
    });

    it("should specify that orchestrator is an invisible router", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Output:** JSON only");
        expect(result).toContain("You're invisible - users never see your output");
    });

    it("should contain phase transition rules", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Phase Transitions");
        expect(result).toContain("Success → Next");
        expect(result).toContain("Failure → Retry");
    });

    it("should specify loop prevention", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Loop Prevention");
        expect(result).toContain("Understand the workflow narrative to avoid loops");
        expect(result).toContain("Don't route to agents who just completed their work");
    });
});

describe("Orchestrator No Assumptions Principle", () => {
    it("should contain key routing rules", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Key Rules");
        expect(result).toContain("You're invisible - users never see your output");
        expect(result).toContain("Messages are NEVER for you - find the right recipient");
        expect(result).toContain("ALWAYS route to at least one agent");
    });

    it("should emphasize JSON-only output", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Output:** JSON only");
        expect(result).toContain("Input/Output Format");
    });

    it("should show routing decision logic", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Decision Logic");
        expect(result).toContain("No agents have been routed yet");
        expect(result).toContain("Workflow narrative shows completed actions");
    });

    it("should specify agent capabilities clearly", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Agent Capabilities");
        expect(result).toContain("executor | ✅ YES | Files, commands, implementation");
        expect(result).toContain("planner | ❌ NO | Architecture, design decisions");
        expect(result).toContain("project-manager | ❌ NO | Requirements, knowledge, summaries");
    });
});
