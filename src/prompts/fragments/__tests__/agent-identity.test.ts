import { describe, expect, it } from "bun:test";
import { agentIdentityFragment } from "../01-agent-identity";
import { shortenPubkey } from "@/utils/conversation-id";

describe("agentIdentityFragment", () => {
    it("renders agent identity with slug, shortened pubkey, and category", () => {
        const pubkey = "abcd1234567890efabcd1234567890efabcd1234567890efabcd1234567890ef";

        const result = agentIdentityFragment.template({
            agent: {
                name: "Test Agent",
                slug: "test-agent",
                role: "builder",
                category: "domain-expert",
                pubkey,
                signer: {
                    npub: "npub1testabcdef",
                    nsec: "nsec1test",
                },
            } as any,
        });

        expect(result).toContain(`Your name: test-agent (${shortenPubkey(pubkey)})`);
        expect(result).toContain("Your category: domain-expert");
        expect(result).not.toContain("Your role:");
        expect(result).not.toContain("Your shortened pubkey:");
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
