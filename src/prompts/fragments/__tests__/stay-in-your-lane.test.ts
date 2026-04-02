import { describe, expect, it } from "bun:test";
import { delegationTipsFragment } from "../16-stay-in-your-lane";

describe("delegationTipsFragment", () => {
    it("should have correct id and priority", () => {
        expect(delegationTipsFragment.id).toBe("delegation-tips");
        expect(delegationTipsFragment.priority).toBe(16);
    });

    it("should render delegation tips content", () => {
        const result = delegationTipsFragment.template();

        expect(result).toContain("## Delegation Tips");
        expect(result).toContain("BAD:");
        expect(result).toContain("GOOD:");
        expect(result).toContain("async");
    });
});
