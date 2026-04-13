import { describe, expect, it } from "bun:test";
import { domainExpertGuidanceFragment } from "../15-domain-expert-guidance";

describe("domainExpertGuidanceFragment", () => {
    it("contains the exact refusal string for out-of-domain requests", () => {
        const result = domainExpertGuidanceFragment.template({});
        expect(result).toContain(
            "I can't help with that — this is outside my domain of expertise."
        );
    });

    it("instructs the agent never to delegate", () => {
        const result = domainExpertGuidanceFragment.template({});
        expect(result).toContain("NEVER delegate");
    });

    it("has the correct fragment id and priority", () => {
        expect(domainExpertGuidanceFragment.id).toBe("domain-expert-guidance");
        expect(domainExpertGuidanceFragment.priority).toBe(15);
    });
});
