import { describe, expect, it } from "bun:test";
import { orchestratorDelegationGuidanceFragment } from "../19-orchestrator-delegation-guidance";

describe("orchestratorDelegationGuidanceFragment", () => {
    it("tells orchestrators to evaluate delegation before executing", () => {
        const result = orchestratorDelegationGuidanceFragment.template({});

        expect(result).toContain('When the user says "do X"');
        expect(result).toContain("Your first job is to evaluate who should handle the work.");
        expect(result).toContain("Prefer delegating execution to the most appropriate agent");
    });

    it("has the correct fragment id and priority", () => {
        expect(orchestratorDelegationGuidanceFragment.id).toBe("orchestrator-delegation-guidance");
        expect(orchestratorDelegationGuidanceFragment.priority).toBe(15);
    });
});
