import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Variables to control mock behavior
let mockProjectContext: any = null;
let mockWhitelistedPubkeys: string[] = [];
let mockBackendPubkey: string | null = "backend-pubkey-hex";
let mockBackendSignerError = false;
let mockConfigError = false;

// Mock the modules before importing TrustPubkeyService
// Note: ConfigService needs getConfigPath for AgentStorage (loaded by test-setup preload)
mock.module("@/services/ConfigService", () => ({
    config: {
        getConfig: () => {
            if (mockConfigError) {
                throw new Error("Config not loaded");
            }
            return {};
        },
        getConfigPath: (subdir?: string) => `/mock/path/${subdir || ""}`,
        getWhitelistedPubkeys: () => {
            if (mockConfigError) {
                throw new Error("Config not loaded");
            }
            return mockWhitelistedPubkeys;
        },
        getBackendSigner: async () => {
            if (mockBackendSignerError) {
                throw new Error("Backend signer not available");
            }
            return {
                pubkey: mockBackendPubkey,
            };
        },
    },
}));

mock.module("@/services/projects", () => ({
    projectContextStore: {
        getContext: () => mockProjectContext,
    },
}));

mock.module("@/utils/logger", () => ({
    logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// Import after mocking
import { TrustPubkeyService } from "../trust-pubkeys/TrustPubkeyService";

describe("TrustPubkeyService", () => {
    let service: TrustPubkeyService;

    beforeEach(() => {
        // Reset singleton
        (TrustPubkeyService as any).instance = undefined;
        service = TrustPubkeyService.getInstance();
        service.resetAll();

        // Reset mock values
        mockWhitelistedPubkeys = [];
        mockBackendPubkey = "backend-pubkey-hex";
        mockBackendSignerError = false;
        mockConfigError = false;

        // Setup mock project context with agents
        mockProjectContext = {
            agents: new Map<string, AgentInstance>([
                [
                    "code-writer",
                    {
                        name: "Code Writer",
                        slug: "code-writer",
                        pubkey: "agent1-pubkey",
                        role: "developer",
                        llmConfig: "default",
                        tools: [],
                        signer: {} as any,
                    },
                ],
                [
                    "reviewer",
                    {
                        name: "Reviewer",
                        slug: "reviewer",
                        pubkey: "agent2-pubkey",
                        role: "reviewer",
                        llmConfig: "default",
                        tools: [],
                        signer: {} as any,
                    },
                ],
            ]),
            getAgentByPubkey: (pubkey: string) => {
                for (const agent of mockProjectContext.agents.values()) {
                    if (agent.pubkey === pubkey) return agent;
                }
                return undefined;
            },
        };
    });

    describe("getInstance", () => {
        it("should return the same instance", () => {
            const instance1 = TrustPubkeyService.getInstance();
            const instance2 = TrustPubkeyService.getInstance();
            expect(instance1).toBe(instance2);
        });
    });

    describe("isTrusted", () => {
        it("should trust whitelisted pubkeys", async () => {
            mockWhitelistedPubkeys = ["whitelisted-pubkey-1", "whitelisted-pubkey-2"];

            const result = await service.isTrusted("whitelisted-pubkey-1");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("whitelisted");
        });

        it("should trust the backend pubkey", async () => {
            mockBackendPubkey = "the-backend-pubkey";

            const result = await service.isTrusted("the-backend-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("backend");
        });

        it("should trust agent pubkeys", async () => {
            const result = await service.isTrusted("agent1-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("agent");
        });

        it("should trust another agent pubkey", async () => {
            const result = await service.isTrusted("agent2-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("agent");
        });

        it("should not trust unknown pubkeys", async () => {
            const result = await service.isTrusted("unknown-pubkey");

            expect(result.trusted).toBe(false);
            expect(result.reason).toBeUndefined();
        });

        it("should prioritize whitelist over agent check", async () => {
            // Add agent pubkey to whitelist too
            mockWhitelistedPubkeys = ["agent1-pubkey"];

            const result = await service.isTrusted("agent1-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("whitelisted");
        });
    });

    describe("isTrustedSync", () => {
        it("should trust whitelisted pubkeys synchronously", () => {
            mockWhitelistedPubkeys = ["whitelisted-pubkey"];

            const result = service.isTrustedSync("whitelisted-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("whitelisted");
        });

        it("should trust agent pubkeys synchronously", () => {
            const result = service.isTrustedSync("agent1-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("agent");
        });

        it("should use cached backend pubkey for sync check", async () => {
            mockBackendPubkey = "cached-backend-pubkey";

            // Initialize cache
            await service.initializeBackendPubkeyCache();

            const result = service.isTrustedSync("cached-backend-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("backend");
        });

        it("should not trust backend pubkey if cache not initialized", () => {
            mockBackendPubkey = "backend-pubkey-not-cached";

            // Don't initialize cache
            const result = service.isTrustedSync("backend-pubkey-not-cached");

            expect(result.trusted).toBe(false);
        });
    });

    describe("cross-project agent trust via globalAgentPubkeys", () => {
        it("should trust pubkeys from global agent set when no project context", async () => {
            // No project context (simulates cross-project scenario)
            mockProjectContext = null;

            // Set global agent pubkeys (as Daemon would)
            service.setGlobalAgentPubkeys(new Set(["cross-project-agent-pubkey"]));

            const result = await service.isTrusted("cross-project-agent-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("agent");
        });

        it("should trust pubkeys from global agent set in sync path", () => {
            mockProjectContext = null;

            service.setGlobalAgentPubkeys(new Set(["cross-project-agent-pubkey"]));

            const result = service.isTrustedSync("cross-project-agent-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("agent");
        });

        it("should trust pubkey from different project even with project context active", () => {
            // Current project has agent1 and agent2, but NOT cross-project-agent
            const result1 = service.isTrustedSync("cross-project-agent-pubkey");
            expect(result1.trusted).toBe(false);

            // Daemon pushes global set including cross-project agent
            service.setGlobalAgentPubkeys(new Set(["cross-project-agent-pubkey", "agent1-pubkey"]));

            const result2 = service.isTrustedSync("cross-project-agent-pubkey");
            expect(result2.trusted).toBe(true);
            expect(result2.reason).toBe("agent");
        });

        it("should still reject unknown pubkeys with global set populated", () => {
            service.setGlobalAgentPubkeys(new Set(["known-agent-pubkey"]));

            const result = service.isTrustedSync("unknown-pubkey");

            expect(result.trusted).toBe(false);
        });

        it("should preserve global agent pubkeys on clearCache (config-only clear)", () => {
            service.setGlobalAgentPubkeys(new Set(["cross-project-agent-pubkey"]));

            // Verify it's trusted
            expect(service.isTrustedSync("cross-project-agent-pubkey").trusted).toBe(true);

            // Clear config cache only
            service.clearCache();

            // Global agent pubkeys should still be trusted (not config-derived)
            expect(service.isTrustedSync("cross-project-agent-pubkey").trusted).toBe(true);
        });

        it("should clear global agent pubkeys on resetAll", () => {
            service.setGlobalAgentPubkeys(new Set(["cross-project-agent-pubkey"]));

            // Verify it's trusted
            expect(service.isTrustedSync("cross-project-agent-pubkey").trusted).toBe(true);

            // Full state reset
            service.resetAll();

            // Should no longer be trusted
            expect(service.isTrustedSync("cross-project-agent-pubkey").trusted).toBe(false);
        });

        it("should include global agent pubkeys in getAllTrustedPubkeys", async () => {
            mockProjectContext = null;
            service.setGlobalAgentPubkeys(new Set(["global-agent-1", "global-agent-2"]));

            const trusted = await service.getAllTrustedPubkeys();

            const agentEntries = trusted.filter((t) => t.reason === "agent");
            expect(agentEntries.length).toBe(2);
            expect(agentEntries.map((e) => e.pubkey).sort()).toEqual(["global-agent-1", "global-agent-2"]);
        });

        it("should de-duplicate between project context and global set", async () => {
            // agent1-pubkey is in both project context and global set
            service.setGlobalAgentPubkeys(new Set(["agent1-pubkey", "cross-project-agent"]));

            const trusted = await service.getAllTrustedPubkeys();

            const agentEntries = trusted.filter((t) => t.reason === "agent");
            // Should be 3: agent1-pubkey, agent2-pubkey (from context), cross-project-agent (from global)
            expect(agentEntries.length).toBe(3);
        });

        it("should trust event from cross-project agent via isTrustedEventSync", () => {
            mockProjectContext = null;
            service.setGlobalAgentPubkeys(new Set(["cross-project-agent-pubkey"]));

            const event = { pubkey: "cross-project-agent-pubkey", id: "event-id" } as NDKEvent;
            const result = service.isTrustedEventSync(event);

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("agent");
        });
    });

    describe("seed + sync interaction (daemon behavior simulation)", () => {
        /**
         * These tests simulate the Daemon's behavior:
         * 1. At startup, seed with all known pubkeys from AgentStorage
         * 2. As projects start/stop, sync with union of active + stored pubkeys
         *
         * The key invariant: stored pubkeys from non-running projects must never
         * be dropped after a sync call.
         */

        it("should retain seeded pubkeys after a sync with different active pubkeys", () => {
            // Step 1: Daemon seeds from AgentStorage at startup (3 agents across all projects)
            const storedPubkeys = new Set(["agent-proj-a", "agent-proj-b", "agent-proj-c"]);
            service.setGlobalAgentPubkeys(storedPubkeys);

            // Verify all seeded pubkeys are trusted
            expect(service.isTrustedSync("agent-proj-a").trusted).toBe(true);
            expect(service.isTrustedSync("agent-proj-b").trusted).toBe(true);
            expect(service.isTrustedSync("agent-proj-c").trusted).toBe(true);

            // Step 2: Daemon sync after project A starts (only proj-a agents are active)
            // The Daemon's syncTrustServiceAgentPubkeys should union stored + active
            // Simulating what the fixed Daemon does: union of active runtime + stored
            const activePubkeys = new Set(["agent-proj-a"]);
            const unioned = new Set([...activePubkeys, ...storedPubkeys]);
            service.setGlobalAgentPubkeys(unioned);

            // All original stored pubkeys must still be trusted
            expect(service.isTrustedSync("agent-proj-a").trusted).toBe(true);
            expect(service.isTrustedSync("agent-proj-b").trusted).toBe(true);
            expect(service.isTrustedSync("agent-proj-c").trusted).toBe(true);
        });

        it("should handle sync after project removal retaining stored pubkeys", () => {
            // Seed from storage
            const storedPubkeys = new Set(["agent-1", "agent-2", "agent-3"]);
            service.setGlobalAgentPubkeys(storedPubkeys);

            // Project with agent-2 stops, runtime only has agent-1 and agent-3
            // Fixed Daemon unions: runtime {agent-1, agent-3} ∪ stored {agent-1, agent-2, agent-3}
            const afterRemoval = new Set(["agent-1", "agent-3", ...storedPubkeys]);
            service.setGlobalAgentPubkeys(afterRemoval);

            // agent-2 should still be trusted (came from storage seed)
            expect(service.isTrustedSync("agent-2").trusted).toBe(true);
        });

        it("should include newly discovered agents not in storage seed", () => {
            // Seed from storage (old set)
            const storedPubkeys = new Set(["agent-old-1", "agent-old-2"]);
            service.setGlobalAgentPubkeys(storedPubkeys);

            // A new project starts with a new agent not yet in storage
            // Fixed Daemon unions: runtime {agent-old-1, agent-new-1} ∪ stored {agent-old-1, agent-old-2}
            const afterNewProject = new Set(["agent-old-1", "agent-new-1", ...storedPubkeys]);
            service.setGlobalAgentPubkeys(afterNewProject);

            // All should be trusted
            expect(service.isTrustedSync("agent-old-1").trusted).toBe(true);
            expect(service.isTrustedSync("agent-old-2").trusted).toBe(true);
            expect(service.isTrustedSync("agent-new-1").trusted).toBe(true);
        });
    });

    describe("getAllTrustedPubkeys", () => {
        it("should return all trusted pubkeys with reasons", async () => {
            mockWhitelistedPubkeys = ["whitelisted-1", "whitelisted-2"];
            mockBackendPubkey = "backend-pubkey";

            const trusted = await service.getAllTrustedPubkeys();

            // Should have whitelisted + backend + agents
            expect(trusted.length).toBe(5); // 2 whitelisted + 1 backend + 2 agents

            // Check whitelisted
            expect(trusted.filter((t) => t.reason === "whitelisted").length).toBe(2);

            // Check backend
            expect(trusted.filter((t) => t.reason === "backend").length).toBe(1);

            // Check agents
            expect(trusted.filter((t) => t.reason === "agent").length).toBe(2);
        });

        it("should de-duplicate pubkeys and use highest precedence reason", async () => {
            // Backend pubkey is also whitelisted - should only appear once as "whitelisted"
            mockBackendPubkey = "dual-role-pubkey";
            mockWhitelistedPubkeys = ["dual-role-pubkey"];

            const trusted = await service.getAllTrustedPubkeys();

            // Find the dual-role pubkey
            const dualRoleEntries = trusted.filter(
                (t) => t.pubkey === "dual-role-pubkey"
            );

            expect(dualRoleEntries.length).toBe(1);
            expect(dualRoleEntries[0].reason).toBe("whitelisted");
        });

        it("should give backend precedence over agent", async () => {
            // Make an agent have the same pubkey as backend
            mockBackendPubkey = "agent1-pubkey";

            const trusted = await service.getAllTrustedPubkeys();

            // Find the shared pubkey
            const sharedEntries = trusted.filter((t) => t.pubkey === "agent1-pubkey");

            expect(sharedEntries.length).toBe(1);
            expect(sharedEntries[0].reason).toBe("backend");
        });

        it("should handle signer failure gracefully", async () => {
            mockBackendSignerError = true;

            const trusted = await service.getAllTrustedPubkeys();

            // Should still return agents but no backend
            expect(trusted.filter((t) => t.reason === "backend").length).toBe(0);
            expect(trusted.filter((t) => t.reason === "agent").length).toBe(2);
        });
    });

    describe("when project context is not available", () => {
        beforeEach(() => {
            mockProjectContext = null;
        });

        it("should not trust agent pubkeys without global set", async () => {
            const result = await service.isTrusted("agent1-pubkey");

            expect(result.trusted).toBe(false);
        });

        it("should still trust whitelisted pubkeys", async () => {
            mockWhitelistedPubkeys = ["whitelisted-pubkey"];

            const result = await service.isTrusted("whitelisted-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("whitelisted");
        });

        it("should still trust backend pubkey", async () => {
            const result = await service.isTrusted("backend-pubkey-hex");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("backend");
        });

        it("getAllTrustedPubkeys should exclude agent pubkeys without global set", async () => {
            const trusted = await service.getAllTrustedPubkeys();

            expect(trusted.filter((t) => t.reason === "agent").length).toBe(0);
        });
    });

    describe("error handling", () => {
        it("should handle config error gracefully in isTrusted", async () => {
            mockConfigError = true;

            // Should not throw, just not trust
            const result = await service.isTrusted("some-pubkey");

            expect(result.trusted).toBe(false);
        });

        it("should handle backend signer error gracefully in isTrusted", async () => {
            mockBackendSignerError = true;

            // Backend pubkey won't be trusted when signer fails
            const result = await service.isTrusted("backend-pubkey-hex");

            expect(result.trusted).toBe(false);
        });

        it("should handle backend signer error gracefully in isTrustedSync", async () => {
            mockBackendSignerError = true;

            // Attempt to initialize cache - should fail silently
            await service.initializeBackendPubkeyCache();

            const result = service.isTrustedSync("backend-pubkey-hex");

            expect(result.trusted).toBe(false);
        });

        it("should still trust agents when backend signer fails", async () => {
            mockBackendSignerError = true;

            const result = await service.isTrusted("agent1-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("agent");
        });

        it("should still trust whitelisted when config fails partially", async () => {
            // This simulates config working for whitelist but signer failing
            mockBackendSignerError = true;
            mockWhitelistedPubkeys = ["whitelisted-pubkey"];

            const result = await service.isTrusted("whitelisted-pubkey");

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("whitelisted");
        });
    });

    describe("isTrustedEvent", () => {
        it("should trust events from whitelisted pubkeys", async () => {
            mockWhitelistedPubkeys = ["whitelisted-pubkey"];
            const event = { pubkey: "whitelisted-pubkey", id: "event-id-123" } as NDKEvent;

            const result = await service.isTrustedEvent(event);

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("whitelisted");
        });

        it("should trust events from backend pubkey", async () => {
            mockBackendPubkey = "backend-event-pubkey";
            const event = { pubkey: "backend-event-pubkey", id: "event-id-456" } as NDKEvent;

            const result = await service.isTrustedEvent(event);

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("backend");
        });

        it("should trust events from agent pubkeys", async () => {
            const event = { pubkey: "agent1-pubkey", id: "event-id-789" } as NDKEvent;

            const result = await service.isTrustedEvent(event);

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("agent");
        });

        it("should not trust events from unknown pubkeys", async () => {
            const event = { pubkey: "unknown-pubkey", id: "event-id-xyz" } as NDKEvent;

            const result = await service.isTrustedEvent(event);

            expect(result.trusted).toBe(false);
            expect(result.reason).toBeUndefined();
        });

        it("should not trust events without pubkey", async () => {
            const event = { id: "event-no-pubkey" } as NDKEvent;

            const result = await service.isTrustedEvent(event);

            expect(result.trusted).toBe(false);
        });

        it("should handle events with empty string pubkey", async () => {
            const event = { pubkey: "", id: "event-empty-pubkey" } as NDKEvent;

            const result = await service.isTrustedEvent(event);

            expect(result.trusted).toBe(false);
        });
    });

    describe("isTrustedEventSync", () => {
        it("should trust events from whitelisted pubkeys synchronously", () => {
            mockWhitelistedPubkeys = ["whitelisted-pubkey"];
            const event = { pubkey: "whitelisted-pubkey", id: "event-id-123" } as NDKEvent;

            const result = service.isTrustedEventSync(event);

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("whitelisted");
        });

        it("should trust events from agent pubkeys synchronously", () => {
            const event = { pubkey: "agent1-pubkey", id: "event-id-789" } as NDKEvent;

            const result = service.isTrustedEventSync(event);

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("agent");
        });

        it("should use cached backend pubkey for sync event check", async () => {
            mockBackendPubkey = "cached-backend-for-event";

            // Initialize cache
            await service.initializeBackendPubkeyCache();

            const event = { pubkey: "cached-backend-for-event", id: "event-id" } as NDKEvent;
            const result = service.isTrustedEventSync(event);

            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("backend");
        });

        it("should not trust events without pubkey synchronously", () => {
            const event = { id: "event-no-pubkey" } as NDKEvent;

            const result = service.isTrustedEventSync(event);

            expect(result.trusted).toBe(false);
        });

        it("should not trust events from unknown pubkeys synchronously", () => {
            const event = { pubkey: "unknown-pubkey", id: "event-id" } as NDKEvent;

            const result = service.isTrustedEventSync(event);

            expect(result.trusted).toBe(false);
        });

        it("should not trust events from backend pubkey before cache initialization", () => {
            mockBackendPubkey = "backend-pubkey-not-cached";
            const event = { pubkey: "backend-pubkey-not-cached", id: "event-id" } as NDKEvent;

            // Don't initialize cache - test that sync returns false for backend pubkey
            const result = service.isTrustedEventSync(event);

            expect(result.trusted).toBe(false);
        });
    });

    describe("caching behavior", () => {
        it("should use cached backend pubkey on subsequent calls", async () => {
            mockBackendPubkey = "cached-backend";

            // First call should fetch and cache
            const result1 = await service.isTrusted("cached-backend");
            expect(result1.trusted).toBe(true);
            expect(result1.reason).toBe("backend");

            // Change the mock - but cache should still work
            mockBackendPubkey = "different-backend";

            // Should still trust the cached value
            const result2 = await service.isTrusted("cached-backend");
            expect(result2.trusted).toBe(true);
            expect(result2.reason).toBe("backend");

            // New value should not be trusted (not re-fetched)
            const result3 = await service.isTrusted("different-backend");
            expect(result3.trusted).toBe(false);
        });

        it("should clear cache properly", async () => {
            mockBackendPubkey = "original-backend";

            // Populate cache
            await service.isTrusted("original-backend");

            // Clear cache
            service.clearCache();

            // Change mock
            mockBackendPubkey = "new-backend";

            // Now should fetch new value
            const result = await service.isTrusted("new-backend");
            expect(result.trusted).toBe(true);
            expect(result.reason).toBe("backend");
        });
    });
});
