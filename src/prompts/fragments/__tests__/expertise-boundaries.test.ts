import { describe, it, expect } from "bun:test";
import { expertiseBoundariesFragment } from "../expertise-boundaries";

describe("expertiseBoundariesFragment", () => {
    it("should return empty string for orchestrator agents", () => {
        const result = expertiseBoundariesFragment.template({
            agentRole: "Project Manager",
            isOrchestrator: true,
        });

        expect(result).toBe("");
    });

    it("should provide expertise boundaries guidance for specialist agents", () => {
        const result = expertiseBoundariesFragment.template({
            agentRole: "Frontend Developer",
            isOrchestrator: false,
        });

        expect(result).toContain("## Expertise Boundaries");
        expect(result).toContain("Frontend Developer");
        expect(result).toContain("Stay Within Your Domain");
        expect(result).toContain("Defer When Appropriate");
        expect(result).toContain("Collaborate, Don't Overreach");
        expect(result).toContain("Quality Over Scope");
    });

    it("should validate args correctly", () => {
        expect(
            expertiseBoundariesFragment.validateArgs({
                agentRole: "Backend Developer",
                isOrchestrator: false,
            })
        ).toBe(true);

        expect(
            expertiseBoundariesFragment.validateArgs({
                agentRole: "Backend Developer",
            })
        ).toBe(false);

        expect(
            expertiseBoundariesFragment.validateArgs({
                isOrchestrator: false,
            })
        ).toBe(false);

        expect(expertiseBoundariesFragment.validateArgs(null)).toBe(false);
        expect(expertiseBoundariesFragment.validateArgs({})).toBe(false);
    });

    it("should emphasize staying within specialization", () => {
        const result = expertiseBoundariesFragment.template({
            agentRole: "DevOps Engineer",
            isOrchestrator: false,
        });

        expect(result).toContain(
            "Focus exclusively on tasks and feedback that align with your specialized role"
        );
        expect(result).toContain("If you encounter work that falls outside your expertise");
        expect(result).toContain("Your value comes from deep expertise in your specific domain");
    });
});
