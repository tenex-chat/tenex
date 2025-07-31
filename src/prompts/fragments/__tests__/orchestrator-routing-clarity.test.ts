import { describe, expect, it } from "bun:test";
import {
    orchestratorRoutingInstructionsFragment,
    orchestratorHandoffGuidanceFragment,
} from "../orchestrator-routing";

describe("Orchestrator Routing - Clarity-Based Decision Making", () => {
    it("should contain request clarity assessment instructions", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Initial Phase Routing");
        expect(result).toContain("Analyze the user's message to determine the appropriate starting phase");
        expect(result).toContain("Clear, specific requests with actionable instructions");
        expect(result).toContain("Clear but architecturally complex tasks");
        expect(result).toContain("Ambiguous, unclear, or exploratory requests");
    });

    it("should specify clarity-based routing actions", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        // Clear requests
        expect(result).toContain("→ EXECUTE phase");
        expect(result).toContain("Has explicit action verbs");

        // Complex clear requests
        expect(result).toContain("→ PLAN phase");
        expect(result).toContain("requires significant design decisions");

        // Ambiguous requests
        expect(result).toContain("→ CHAT phase");
        expect(result).toContain("Route to project-manager for requirements gathering");
    });

    it("should contain mandatory double-consultation instructions", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Quality Control Guidelines");
        expect(result).toContain("Ensure quality through review cycles");
        expect(result).toContain(
            "If no experts: Route to project-manager for review"
        );
    });

    it("should contain availability-based verification strategy", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Quality Control Guidelines");
        expect(result).toContain("EXECUTE Phase Process");
        expect(result).toContain(
            "If no experts: Route to project-manager for review"
        );
        expect(result).toContain(
            "Collect all feedback, route back if needed"
        );
    });

    it("should enforce mandatory post-execute phases", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain(
            "After execution work, you MUST proceed through VERIFICATION → CHORES → REFLECTION"
        );
        expect(result).toContain("VERIFICATION Phase");
        expect(result).toContain("Emergency fixes: Can skip VERIFICATION/CHORES/REFLECTION if critical");
    });

    it("should specify that orchestrator is a silent router", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain(
            "Silent Orchestrator Routing Instructions"
        );
        expect(result).toContain("NEVER write messages to users");
        expect(result).toContain("Your ONLY tool:** continue()");
    });

    it("should contain feedback collection instructions", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Review Interpretation");
        expect(result).toContain(
            "Approval signals:"
        );
        expect(result).toContain(
            "Mixed feedback:** Route ALL feedback back to primary agent"
        );
    });

    it("should specify verification-execute feedback loop", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("If issues: Back to EXECUTE");
        expect(result).toContain("If good: Proceed to CHORES");
        expect(result).toContain("Focus: \"Does this work for users?\"");
    });
});

describe("Orchestrator Handoff Guidance", () => {
    it("should not mention complexity assessment", () => {
        const routingResult = orchestratorRoutingInstructionsFragment.template();
        const handoffResult = orchestratorHandoffGuidanceFragment.template();

        // Should not contain "complexity" or "complex" in the context of task assessment
        expect(routingResult).not.toContain("Task Complexity Assessment");
        expect(handoffResult).not.toContain("assess the complexity");
    });

    it("should emphasize agent availability for routing decisions", () => {
        const result = orchestratorHandoffGuidanceFragment.template();

        expect(result).toContain("Agent Capabilities Match");
        expect(result).toContain("When to Use Multi-Agent Queries");
        expect(result).toContain("Gathering specialized knowledge from domain experts");
    });
});

describe("Orchestrator No Assumptions Principle", () => {
    it("should explicitly forbid adding assumptions", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Pure Routing Rules");
        expect(result).toContain("Don't compose messages or instructions");
        expect(result).toContain("Your ONLY job is to make routing decisions");
    });

    it("should provide clear examples of no assumptions", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        // Should show routing rules
        expect(result).toContain(
            'The continue() tool directly executes agents'
        );
        expect(result).toContain(
            'Target agents process the event as if they were p-tagged originally'
        );
    });

    it("should show routing principles", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain(
            "Messages are NEVER for you - find the right recipient"
        );
        expect(result).toContain("Just decide WHERE to route (which agents/phase)");
        expect(result).toContain("Don't respond to messages - route them");
    });

    it("should emphasize routing without modification", () => {
        const result = orchestratorRoutingInstructionsFragment.template();

        expect(result).toContain("Pure Routing Rules");
        expect(result).toContain("You remain completely invisible to users");
        expect(result).toContain("Every message needs a recipient - find who should handle it");
    });
});
