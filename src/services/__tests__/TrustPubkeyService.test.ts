import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Variables to control mock behavior
let mockProjectContext: any = null;
let mockProjectContextInitialized = true;
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
    getProjectContext: () => mockProjectContext,
    isProjectContextInitialized: () => mockProjectContextInitialized,
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
        service.clearCache();

        // Reset mock values
        mockWhitelistedPubkeys = [];
        mockBackendPubkey = "backend-pubkey-hex";
        mockProjectContextInitialized = true;
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

    describe("when project context is not initialized", () => {
        beforeEach(() => {
            mockProjectContextInitialized = false;
        });

        it("should not trust agent pubkeys", async () => {
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

        it("getAllTrustedPubkeys should exclude agent pubkeys", async () => {
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
