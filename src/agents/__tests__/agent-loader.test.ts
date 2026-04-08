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

    it("returns before categorization completes", async () => {
        // categorizeAgent hangs indefinitely
        categorizeAgentMock.mockReturnValue(new Promise(() => {}));

        const signer = NDKPrivateKeySigner.generate();
        const storedAgent = createStoredAgent({
            nsec: signer.nsec,
            slug: "lazy-nonblock",
            name: "Nonblocking Test",
            role: "assistant",
        });

        const loadAgentSpy = spyOn(agentStorage, "loadAgent").mockResolvedValue(storedAgent);
        const skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => []),
        } as never);

        const start = Date.now();
        await loadStoredAgentIntoRegistry(signer.pubkey, makeRegistry());
        expect(Date.now() - start).toBeLessThan(1000);

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
