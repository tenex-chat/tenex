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

  it("should return delegation completion instructions when enabled", () => {
    const result = delegationCompletionFragment.template({ isDelegationCompletion: true });
    expect(result).toContain("CRITICAL: DELEGATION COMPLETION NOTIFICATION");
    expect(result).toContain("STOP! A delegated task has JUST BEEN COMPLETED");
    expect(result).toContain("Pass the result back to the user");
    expect(result).toContain("Do NOT use ANY tools");
    expect(result).toContain("Do NOT delegate again");
    expect(result).toContain("THE TASK IS COMPLETE. DO NOT REPEAT IT");
    expect(result).toContain("DO NOT use delegate(), delegate_phase(), or any other tool");
  });
});