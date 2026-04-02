import { describe, expect, it } from "bun:test";
import { agentIdentityFragment } from "../01-agent-identity";

describe("agentIdentityFragment", () => {
    it("renders agent identity with name, shortened pubkey, and nsec note", () => {
        const result = agentIdentityFragment.template({
            agent: {
                name: "Test Agent",
                slug: "test-agent",
                role: "builder",
                pubkey: "abcd1234567890efabcd1234567890efabcd1234567890efabcd1234567890ef",
                signer: {
                    npub: "npub1testabcdef",
                    nsec: "nsec1test",
                },
            } as any,
        });

        expect(result).toContain("Your name: Test Agent (test-agent)");
        expect(result).toContain("Your shortened pubkey: abcd1234567890efab");
        expect(result).toContain("Your role: builder");
        expect(result).toContain(".env");
        expect(result).toContain("NSEC");
        expect(result).not.toContain("nsec1test");
        expect(result).not.toContain("<project-context>");
    });

    it("includes agent instructions when provided", () => {
        const result = agentIdentityFragment.template({
            agent: {
                name: "Test Agent",
                slug: "test-agent",
                role: "builder",
                pubkey: "abcd1234567890efabcd1234567890efabcd1234567890efabcd1234567890ef",
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
