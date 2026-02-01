import { describe, expect, it } from "bun:test";
import { stayInYourLaneFragment } from "../16-stay-in-your-lane";

describe("stayInYourLaneFragment", () => {
    it("should have correct id", () => {
        expect(stayInYourLaneFragment.id).toBe("stay-in-your-lane");
    });

    it("should have priority 16", () => {
        expect(stayInYourLaneFragment.priority).toBe(16);
    });

    it("should render delegation best practices content", () => {
        const result = stayInYourLaneFragment.template();

        expect(result).toContain("## Delegation Best Practices");
    });

    it("should include self-reflection questions", () => {
        const result = stayInYourLaneFragment.template();

        expect(result).toContain("Before delegating, ask yourself:");
        expect(result).toContain("1. What is MY role and responsibility?");
        expect(result).toContain("2. What is the role of the agent I'm delegating to?");
        expect(result).toContain("3. Am I delegating the TASK or micromanaging the APPROACH?");
    });

    it("should include effective delegation guidelines", () => {
        const result = stayInYourLaneFragment.template();

        expect(result).toContain("Effective delegation:");
        expect(result).toContain("- Provide necessary context and constraints");
        expect(result).toContain("- Trust the delegatee to use their expertise and tools");
        expect(result).toContain("- Focus on outcomes, not step-by-step instructions");
    });

    it("should include anti-patterns to avoid", () => {
        const result = stayInYourLaneFragment.template();

        expect(result).toContain("Avoid:");
        expect(result).toContain("- Telling other agents which specific tools to use");
        expect(result).toContain("- Prescribing implementation details outside your expertise");
        expect(result).toContain("- Duplicating work that the delegatee is better suited for");
        expect(result).toContain("- Micromanaging approaches when you should delegate the entire task");
    });

    it("should include good and bad examples", () => {
        const result = stayInYourLaneFragment.template();

        expect(result).toContain("Example - BAD delegation:");
        expect(result).toContain("Follow this exact sequence: search the codebase for X, read files Y and Z, then modify function F with the following changes...");
        expect(result).toContain("Example - GOOD delegation:");
        expect(result).toContain("Find and fix the authentication bug in the login flow. The issue appears to be related to token validation.");
    });

    it("should emphasize core principle and respecting expertise", () => {
        const result = stayInYourLaneFragment.template();

        expect(result).toContain("Core Principle: Delegate WHAT needs to be done, not HOW to do it.");
        expect(result).toContain("Each agent has specialized knowledge and tools - respect their expertise.");
    });
});
