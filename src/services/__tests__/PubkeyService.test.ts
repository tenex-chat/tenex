import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentInstance } from "@/agents/types";

// Variables to control mock behavior
let mockProjectContext: any = null;
let mockProjectContextInitialized = true;
let mockNdkFetchEvent: any = null;

// Mock the modules before importing PubkeyService
mock.module("@/nostr", () => ({
    getNDK: () => ({
        fetchEvent: async () => mockNdkFetchEvent,
    }),
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
import { PubkeyService } from "../PubkeyService";

describe("PubkeyService", () => {
    let service: PubkeyService;

    beforeEach(() => {
        // Reset singleton
        (PubkeyService as any).instance = undefined;
        service = PubkeyService.getInstance();

        // Reset mock values
        mockNdkFetchEvent = null;
        mockProjectContextInitialized = true;

        // Setup mock project context with agents
        const agentsMap = new Map<string, AgentInstance>([
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
                "tester",
                {
                    name: "Tester",
                    slug: "tester",
                    pubkey: "agent2-pubkey",
                    role: "tester",
                    llmConfig: "default",
                    tools: [],
                    signer: {} as any,
                },
            ],
        ]);

        // Build pubkey -> agent map for getAgentByPubkey
        const agentsByPubkey = new Map<string, AgentInstance>();
        for (const agent of agentsMap.values()) {
            agentsByPubkey.set(agent.pubkey, agent);
        }

        mockProjectContext = {
            pubkey: "project-pubkey",
            agents: agentsMap,
            getAgentByPubkey: (pubkey: string) => agentsByPubkey.get(pubkey),
        };

        // Clear any cached data
        service.clearCache();
    });

    describe("Agent name resolution", () => {
        it("should return agent slug for agent pubkey", async () => {
            const name = await service.getName("agent1-pubkey");
            expect(name).toBe("code-writer");
        });

        it("should return agent slug synchronously", () => {
            const name = service.getNameSync("agent2-pubkey");
            expect(name).toBe("tester");
        });

        it("should handle project context not initialized", async () => {
            mockProjectContextInitialized = false;

            const name = await service.getName("agent1-pubkey");
            expect(name).toBe("agent1-pubke"); // Falls back to shortened pubkey (12 chars)
        });
    });

    describe("User profile fetching", () => {
        it("should fetch and cache user profile from kind:0 event", async () => {
            mockNdkFetchEvent = {
                id: "profile-event-id",
                content: JSON.stringify({
                    name: "Alice",
                    display_name: "Alice Smith",
                    about: "Nostr user",
                    picture: "https://example.com/pic.jpg",
                }),
            };

            const name = await service.getName("user-pubkey");
            expect(name).toBe("Alice"); // name takes priority
        });

        it("should prioritize name over display_name", async () => {
            mockNdkFetchEvent = {
                id: "profile-event-id",
                content: JSON.stringify({
                    name: "alice",
                    display_name: "Alice Smith",
                }),
            };

            const name = await service.getName("user-pubkey");
            expect(name).toBe("alice");
        });

        it("should fall back to display_name if no name", async () => {
            mockNdkFetchEvent = {
                id: "profile-event-id",
                content: JSON.stringify({
                    display_name: "Alice Display",
                    username: "alice123",
                }),
            };

            const name = await service.getName("user-pubkey");
            expect(name).toBe("Alice Display");
        });

        it("should fall back to username if no name or display_name", async () => {
            mockNdkFetchEvent = {
                id: "profile-event-id",
                content: JSON.stringify({
                    username: "alice123",
                    about: "Just a user",
                }),
            };

            const name = await service.getName("user-pubkey");
            expect(name).toBe("alice123");
        });

        it("should return shortened pubkey if profile is empty", async () => {
            mockNdkFetchEvent = null;

            const name = await service.getName("user-without-profile");
            expect(name).toBe("user-without"); // First 12 chars (PREFIX_LENGTH)
        });

        it("should handle malformed profile content", async () => {
            mockNdkFetchEvent = {
                id: "profile-event-id",
                content: "not-valid-json",
            };

            const name = await service.getName("user-with-bad-profile");
            expect(name).toBe("user-with-ba"); // First 12 chars (PREFIX_LENGTH)
        });
    });

    describe("Cache management", () => {
        it("should clear cache", async () => {
            mockNdkFetchEvent = {
                id: "profile-id",
                content: JSON.stringify({ name: "Bob" }),
            };

            await service.getName("user-pubkey");
            service.clearCache();

            const stats = service.getCacheStats();
            expect(stats.size).toBe(0);
        });

        it("should provide cache statistics", async () => {
            mockNdkFetchEvent = {
                id: "profile-id",
                content: JSON.stringify({ name: "Charlie" }),
            };

            await service.getName("user1-pubkey");
            await service.getName("user2-pubkey");

            const stats = service.getCacheStats();
            expect(stats.size).toBe(2);
            expect(stats.entries).toContain("user1-pubkey");
            expect(stats.entries).toContain("user2-pubkey");
        });
    });

    describe("getNameSync", () => {
        it("should return agent slug synchronously for agents", () => {
            const name = service.getNameSync("agent1-pubkey");
            expect(name).toBe("code-writer");
        });

        it("should return cached user name if available", async () => {
            mockNdkFetchEvent = {
                id: "profile-id",
                content: JSON.stringify({ name: "Dave" }),
            };

            // First fetch to populate cache
            await service.getName("user-pubkey");

            // Now sync should work from cache
            const name = service.getNameSync("user-pubkey");
            expect(name).toBe("Dave");
        });

        it("should return shortened pubkey if not cached", () => {
            const name = service.getNameSync("uncached-user-pubkey");
            expect(name).toBe("uncached-use"); // First 12 chars (PREFIX_LENGTH)
        });
    });
});
