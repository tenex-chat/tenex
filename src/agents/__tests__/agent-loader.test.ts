import { describe, expect, it, mock, spyOn } from "bun:test";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { createStoredAgent } from "@/agents/AgentStorage";
import { createAgentInstance } from "@/agents/agent-loader";
import * as skillBlocking from "@/services/skill/skill-blocking";

describe("agent-loader", () => {
    it("filters blocked always-on skills when hydrating an agent instance", () => {
        const filterSpy = spyOn(skillBlocking, "filterBlockedSkills").mockReturnValue({
            allowed: ["allowed-loader-skill"],
            blocked: ["blocked-loader-skill"],
        });

        const signer = NDKPrivateKeySigner.generate();
        const storedAgent = createStoredAgent({
            nsec: signer.nsec,
            slug: "loader-agent",
            name: "Loader Agent",
            role: "assistant",
            defaultConfig: {
                skills: ["allowed-loader-skill", "blocked-loader-skill"],
                blockedSkills: ["blocked-loader-skill"],
            },
        });

        const registry = {
            getMetadataPath: mock(() => "/tmp/loader-metadata"),
            getBasePath: mock(() => "/tmp/loader-base"),
        } as any;

        const instance = createAgentInstance(storedAgent, registry);

        expect(filterSpy).toHaveBeenCalledWith(
            ["allowed-loader-skill", "blocked-loader-skill"],
            ["blocked-loader-skill"]
        );
        expect(instance.alwaysSkills).toEqual(["allowed-loader-skill"]);
        expect(instance.blockedSkills).toEqual(["blocked-loader-skill"]);

        filterSpy.mockRestore();
    });
});
