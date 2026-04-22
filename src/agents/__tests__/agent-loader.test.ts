import { describe, expect, it, mock, spyOn } from "bun:test";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { agentStorage, createStoredAgent } from "@/agents/AgentStorage";
import { createAgentInstance, loadStoredAgentIntoRegistry } from "@/agents/agent-loader";
import { SkillService } from "@/services/skill/SkillService";
import * as skillBlocking from "@/services/skill/skill-blocking";

// Hoisted by Bun's bundler — runs before any import is resolved
const categorizeAgentMock = mock(async () => "worker" as const);
mock.module("@/agents/categorizeAgent", () => ({
    categorizeAgent: categorizeAgentMock,
}));

describe("agent-loader", () => {
    it("filters blocked always-on skills when hydrating an agent instance", async () => {
        const blockedSet = new Set(["blocked-loader-skill"]);
        const expandedSpy = spyOn(skillBlocking, "buildExpandedBlockedSet").mockReturnValue(blockedSet);
        const filterSpy = spyOn(skillBlocking, "filterBlockedSkills").mockReturnValue({
            allowed: ["allowed-loader-skill"],
            blocked: ["blocked-loader-skill"],
        });
        const skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => []),
        } as never);

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

        const instance = await createAgentInstance(storedAgent, registry);

        expect(expandedSpy).toHaveBeenCalledWith(["blocked-loader-skill"], expect.any(Map));
        expect(filterSpy).toHaveBeenCalledWith(
            ["allowed-loader-skill", "blocked-loader-skill"],
            blockedSet,
            expect.any(Map)
        );
        expect(instance.alwaysSkills).toEqual(["allowed-loader-skill"]);
        expect(instance.blockedSkills).toEqual(["blocked-loader-skill"]);

        expandedSpy.mockRestore();
        filterSpy.mockRestore();
        skillServiceSpy.mockRestore();
    });
});

describe("loadStoredAgentIntoRegistry - lazy categorization", () => {
    function makeRegistry() {
        return {
            getAgentByPubkey: mock(() => undefined),
            getProjectDTag: mock(() => "test-project"),
            getNDKProject: mock(() => undefined),
            addAgent: mock(() => {}),
            getBasePath: mock(() => "/tmp/test-base"),
            getMetadataPath: mock(() => "/tmp/test-meta"),
        } as any;
    }

    it("awaits categorization and applies the result to tool assignment", async () => {
        // categorizeAgent resolves synchronously to domain-expert
        categorizeAgentMock.mockResolvedValue("domain-expert");

        const signer = NDKPrivateKeySigner.generate();
        const storedAgent = createStoredAgent({
            nsec: signer.nsec,
            slug: "sync-categorized",
            name: "Sync Categorized",
            role: "assistant",
        });

        const loadAgentSpy = spyOn(agentStorage, "loadAgent").mockResolvedValue(storedAgent);
        const skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => []),
        } as never);

        const instance = await loadStoredAgentIntoRegistry(signer.pubkey, makeRegistry());

        // Category must be resolved and reflected in the instance
        expect(instance.category).toBe("domain-expert");

        // Domain-experts must not receive delegation tools
        expect(instance.tools).not.toContain("delegate");
        expect(instance.tools).not.toContain("delegate_followup");

        // But they do retain ask
        expect(instance.tools).toContain("ask");

        loadAgentSpy.mockRestore();
        skillServiceSpy.mockRestore();
        categorizeAgentMock.mockReset();
    });

    it("applies domain-expert tool restrictions when category is stored (no LLM call needed)", async () => {
        // No categorization needed — category already present in storage
        const signer = NDKPrivateKeySigner.generate();
        const storedAgent = createStoredAgent({
            nsec: signer.nsec,
            slug: "stored-expert",
            name: "Stored Expert",
            role: "assistant",
            category: "domain-expert",
        } as any); // createStoredAgent may not expose category directly; cast

        const loadAgentSpy = spyOn(agentStorage, "loadAgent").mockResolvedValue({
            ...storedAgent,
            category: "domain-expert",
        } as any);
        const skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => []),
        } as never);

        const instance = await loadStoredAgentIntoRegistry(signer.pubkey, makeRegistry());

        expect(instance.category).toBe("domain-expert");
        expect(instance.tools).not.toContain("delegate");
        expect(instance.tools).not.toContain("delegate_followup");
        expect(instance.tools).toContain("ask");

        // categorizeAgent must NOT have been called — category was already set
        expect(categorizeAgentMock).not.toHaveBeenCalled();

        loadAgentSpy.mockRestore();
        skillServiceSpy.mockRestore();
        categorizeAgentMock.mockReset();
    });

    it("applies orchestrator skill restrictions when category is stored", async () => {
        const signer = NDKPrivateKeySigner.generate();
        const storedAgent = createStoredAgent({
            nsec: signer.nsec,
            slug: "stored-orchestrator",
            name: "Stored Orchestrator",
            role: "assistant",
            category: "orchestrator",
            defaultConfig: {
                tools: ["skill_list", "skills_set", "fs_read"],
            },
        } as any);

        const loadAgentSpy = spyOn(agentStorage, "loadAgent").mockResolvedValue({
            ...storedAgent,
            category: "orchestrator",
        } as any);
        const skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => []),
        } as never);

        const instance = await loadStoredAgentIntoRegistry(signer.pubkey, makeRegistry());

        expect(instance.category).toBe("orchestrator");
        expect(instance.tools).not.toContain("skill_list");
        expect(instance.tools).not.toContain("skills_set");

        loadAgentSpy.mockRestore();
        skillServiceSpy.mockRestore();
        categorizeAgentMock.mockReset();
    });

    it("swallows errors from categorization and storage", async () => {
        categorizeAgentMock.mockRejectedValue(new Error("LLM unavailable"));

        const signer = NDKPrivateKeySigner.generate();
        const storedAgent = createStoredAgent({
            nsec: signer.nsec,
            slug: "lazy-swallow",
            name: "Swallow Test",
            role: "assistant",
        });

        const loadAgentSpy = spyOn(agentStorage, "loadAgent").mockResolvedValue(storedAgent);
        const updateSpy = spyOn(agentStorage, "updateInferredCategory").mockResolvedValue(true);
        const skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => []),
        } as never);

        // Must not throw even though categorization fails
        await loadStoredAgentIntoRegistry(signer.pubkey, makeRegistry());
        // Flush microtasks so the background catch handler runs
        await new Promise((r) => setTimeout(r, 0));

        loadAgentSpy.mockRestore();
        updateSpy.mockRestore();
        skillServiceSpy.mockRestore();
        categorizeAgentMock.mockReset();
    });

    it("cleans up in-flight entry after categorization failure so subsequent load can recategorize", async () => {
        // Reject after a short delay — simulates what a timeout rejection produces
        categorizeAgentMock.mockImplementation(
            () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("categorization timed out")), 10))
        );

        const signer = NDKPrivateKeySigner.generate();
        const pubkey = signer.pubkey;
        const storedAgent = createStoredAgent({
            nsec: signer.nsec,
            slug: "lazy-timeout",
            name: "Timeout Test",
            role: "assistant",
        });

        const loadAgentSpy = spyOn(agentStorage, "loadAgent").mockResolvedValue(storedAgent);
        const skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => []),
        } as never);

        // First load — triggers background categorization that will reject (timeout)
        await loadStoredAgentIntoRegistry(pubkey, makeRegistry());
        // Allow the background promise to reject and `finally` to clean up the in-flight entry
        await new Promise((r) => setTimeout(r, 50));

        expect(categorizeAgentMock).toHaveBeenCalledTimes(1);

        // Second load — in-flight set must be cleared, so categorization triggers again
        await loadStoredAgentIntoRegistry(pubkey, makeRegistry());
        await new Promise((r) => setTimeout(r, 50));

        expect(categorizeAgentMock).toHaveBeenCalledTimes(2);

        loadAgentSpy.mockRestore();
        skillServiceSpy.mockRestore();
        categorizeAgentMock.mockReset();
    });

    it("skips categorization when the same agent is already being categorized", async () => {
        // Resolves after a tick so the first task remains in-flight during the second load
        categorizeAgentMock.mockImplementation(
            () => new Promise((r) => setTimeout(() => r("worker" as const), 0))
        );

        const signer = NDKPrivateKeySigner.generate();
        const pubkey = signer.pubkey;
        const storedAgent = createStoredAgent({
            nsec: signer.nsec,
            slug: "lazy-dedup",
            name: "Dedup Test",
            role: "assistant",
        });

        const loadAgentSpy = spyOn(agentStorage, "loadAgent").mockResolvedValue(storedAgent);
        const updateSpy = spyOn(agentStorage, "updateInferredCategory").mockResolvedValue(true);
        const skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => []),
        } as never);

        const registry = makeRegistry();
        // Fire both loads before awaiting — second call sees first's in-flight entry
        const p1 = loadStoredAgentIntoRegistry(pubkey, registry);
        const p2 = loadStoredAgentIntoRegistry(pubkey, registry);
        await Promise.all([p1, p2]);
        // Allow background tasks to settle
        await new Promise((r) => setTimeout(r, 20));

        expect(categorizeAgentMock).toHaveBeenCalledTimes(1);

        loadAgentSpy.mockRestore();
        updateSpy.mockRestore();
        skillServiceSpy.mockRestore();
        categorizeAgentMock.mockReset();
    });
});
