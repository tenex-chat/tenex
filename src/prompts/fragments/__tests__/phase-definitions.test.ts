import { describe, expect, it } from "bun:test";
import { phaseDefinitionsFragment } from "../phase-definitions";

describe("phaseDefinitionsFragment", () => {
    it("should render phase definitions correctly", () => {
        const result = phaseDefinitionsFragment.template({});

        // Should contain all phase definitions
        expect(result).toContain("## Phase Definitions");
        expect(result).toContain("**CHAT**:");
        expect(result).toContain("**BRAINSTORM**:");
        expect(result).toContain("**PLAN**:");
        expect(result).toContain("**EXECUTE**:");
        expect(result).toContain("**VERIFICATION**:");
        expect(result).toContain("**CHORES**:");
        expect(result).toContain("**REFLECTION**:");

        // Should contain the enhanced descriptions for key phases
        expect(result).toContain("Implementation + technical review by domain experts");
        expect(result).toContain("User acceptance testing - agents act as end users");
        expect(result).toContain("Learning extraction and process improvement");

        // Should contain goals
        expect(result).toContain("Goal:");
    });

    it("should have correct priority", () => {
        expect(phaseDefinitionsFragment.priority).toBe(15);
    });

    it("should be registered with the correct id", () => {
        expect(phaseDefinitionsFragment.id).toBe("phase-definitions");
    });
});
