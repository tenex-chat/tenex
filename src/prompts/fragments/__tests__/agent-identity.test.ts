import { describe, expect, it } from "bun:test";
import { agentIdentityFragment } from "../01-agent-identity";

describe("agentIdentityFragment", () => {
    it("renders agent identity with name, npub, and nsec", () => {
        const nsec = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq26us3r";
        const result = agentIdentityFragment.template({
            agent: {
                name: "Test Agent",
                slug: "test-agent",
                role: "builder",
                signer: {
                    npub: "npub1test",
                    nsec,
                },
            } as any,
        });

        expect(result).toContain("Your name: Test Agent (test-agent)");
        expect(result).toContain("Your npub: npub1test");
        expect(result).toContain("Your role: builder");
        expect(result).toContain(nsec);
        expect(result).not.toContain("<project-context>");
    });

    it("includes agent instructions when provided", () => {
        const result = agentIdentityFragment.template({
            agent: {
                name: "Test Agent",
                slug: "test-agent",
                role: "builder",
                instructions: "You are a helpful builder.",
                signer: {
                    npub: "npub1test",
                    nsec: "nsec1test",
                },
            } as any,
        });

        expect(result).toContain("<agent-instructions>");
        expect(result).toContain("You are a helpful builder.");
    });
});
