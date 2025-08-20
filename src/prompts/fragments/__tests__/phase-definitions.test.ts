import { describe, expect, it } from "bun:test";
import { phaseDefinitionsFragment } from "../10-phase-definitions";

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
    expect(result).toContain(
      "Moment of truth: the phase where all of the work is to be implemented AND reviewed"
    );
    expect(result).toContain(
      "Functional verification of the implemented work from an end-user perspective"
    );
    expect(result).toContain(
      "Provide an opportunity to all agents that were part of this conversation to reflect"
    );

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
