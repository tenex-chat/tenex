import { describe, expect, it } from "bun:test";
import { delegationCompletionFragment } from "../delegation-completion";

describe("delegationCompletionFragment", () => {
    it("should return empty string when isDelegationCompletion is false", () => {
        const result = delegationCompletionFragment.template({ isDelegationCompletion: false });
        expect(result).toBe("");
    });

    it("should return empty string when isDelegationCompletion is undefined", () => {
        const result = delegationCompletionFragment.template({});
        expect(result).toBe("");
    });

    it("should return all-complete instructions when no pending delegations", () => {
        const result = delegationCompletionFragment.template({
            isDelegationCompletion: true,
            hasPendingDelegations: false,
        });
        expect(result).toContain("ALL DELEGATIONS COMPLETE");
        expect(result).toContain("All delegated tasks have completed");
        expect(result).toContain("Synthesize the results and respond to the user");
    });

    it("should return partial-completion instructions when pending delegations exist", () => {
        const result = delegationCompletionFragment.template({
            isDelegationCompletion: true,
            hasPendingDelegations: true,
        });
        expect(result).toContain("DELEGATION UPDATE");
        expect(result).toContain("One or more delegated tasks have completed");
        expect(result).toContain("still waiting for other delegations");
        expect(result).toContain("Acknowledge receipt of partial results");
        expect(result).toContain("Wait silently for remaining delegations");
    });

    it("should default to all-complete when hasPendingDelegations is undefined", () => {
        const result = delegationCompletionFragment.template({
            isDelegationCompletion: true,
        });
        expect(result).toContain("ALL DELEGATIONS COMPLETE");
    });
});
