import { describe, expect, it } from "bun:test";
import { agentIdentityFragment } from "../01-agent-identity";

describe("agentIdentityFragment", () => {
    it("omits the role and raw nsec while pointing agents to the home .env file", () => {
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
            projectTitle: "Test Project",
            projectOwnerPubkey: "owner-pubkey",
            workingDirectory: "/tmp/test-project",
            conversationId: "conversation-1",
        });

        expect(result).toContain("Your name: Test Agent (test-agent)");
        expect(result).toContain("Your npub: npub1test");
        expect(result).toContain("home directory's `.env` file as `NSEC`");
        expect(result).not.toContain("Your role:");
        expect(result).not.toContain(nsec);
    });
});
