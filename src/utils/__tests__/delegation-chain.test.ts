import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatDelegationChain, wouldCreateCircularDelegation, buildDelegationChain } from "../delegation-chain";
import type { DelegationChainEntry } from "@/conversations/ConversationStore";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock functions that will be used by the mocked modules
const mockConversationStoreGet = vi.fn();
const mockConversationStoreGetCachedEvent = vi.fn();

// Mock dependencies - must be before imports that use them
vi.mock("@/conversations/ConversationStore", () => ({
    ConversationStore: {
        get: (...args: unknown[]) => mockConversationStoreGet(...args),
        getCachedEvent: (...args: unknown[]) => mockConversationStoreGetCachedEvent(...args),
    },
}));

vi.mock("@/services/projects", () => ({
    isProjectContextInitialized: () => true,
    getProjectContext: () => ({
        getAgentByPubkey: (pubkey: string) => {
            const agents: Record<string, { slug: string }> = {
                "agent-pubkey-pm": { slug: "pm-wip" },
                "agent-pubkey-exec": { slug: "execution-coordinator" },
                "agent-pubkey-claude": { slug: "claude-code" },
            };
            return agents[pubkey];
        },
    }),
}));

vi.mock("@/utils/logger", () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe("delegation-chain utilities", () => {
    describe("formatDelegationChain", () => {
        it("should format a simple two-entry chain", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "agent-pubkey", displayName: "claude-code", isUser: false },
            ];

            const result = formatDelegationChain(chain, "agent-pubkey");
            expect(result).toBe("User → claude-code (you)");
        });

        it("should format a longer delegation chain", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false },
                { pubkey: "exec-pubkey", displayName: "execution-coordinator", isUser: false },
                { pubkey: "claude-pubkey", displayName: "claude-code", isUser: false },
            ];

            const result = formatDelegationChain(chain, "claude-pubkey");
            expect(result).toBe("User → pm-wip → execution-coordinator → claude-code (you)");
        });

        it("should mark current agent with (you) correctly", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false },
            ];

            const result = formatDelegationChain(chain, "pm-pubkey");
            expect(result).toBe("User → pm-wip (you)");
        });

        it("should handle empty chain gracefully", () => {
            const result = formatDelegationChain([], "some-pubkey");
            expect(result).toBe("");
        });

        it("should handle chain with unknown current agent", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "agent-pubkey", displayName: "agent", isUser: false },
            ];

            const result = formatDelegationChain(chain, "different-pubkey");
            expect(result).toBe("User → agent");
        });
    });

    describe("wouldCreateCircularDelegation", () => {
        it("should detect circular delegation when agent is already in chain", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false },
                { pubkey: "claude-pubkey", displayName: "claude-code", isUser: false },
            ];

            expect(wouldCreateCircularDelegation(chain, "pm-pubkey")).toBe(true);
            expect(wouldCreateCircularDelegation(chain, "claude-pubkey")).toBe(true);
            expect(wouldCreateCircularDelegation(chain, "user-pubkey")).toBe(true);
        });

        it("should return false when agent is not in chain", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false },
            ];

            expect(wouldCreateCircularDelegation(chain, "new-agent-pubkey")).toBe(false);
            expect(wouldCreateCircularDelegation(chain, "execution-coordinator-pubkey")).toBe(false);
        });

        it("should handle empty chain", () => {
            expect(wouldCreateCircularDelegation([], "any-pubkey")).toBe(false);
        });
    });

    describe("buildDelegationChain", () => {
        beforeEach(() => {
            mockConversationStoreGet.mockReset();
            mockConversationStoreGetCachedEvent.mockReset();
        });

        afterEach(() => {
            mockConversationStoreGet.mockReset();
            mockConversationStoreGetCachedEvent.mockReset();
        });

        it("should return undefined for direct user messages (no delegation tag)", () => {
            const event = {
                pubkey: "user-pubkey",
                tags: [],
            } as unknown as NDKEvent;

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");
            expect(result).toBeUndefined();
        });

        it("should build chain with correct ordering: User first, current agent last", () => {
            const event = {
                pubkey: "agent-pubkey-pm",
                tags: [["delegation", "parent-conv-id"]],
            } as unknown as NDKEvent;

            // Mock parent conversation with stored chain starting from User
            const mockParentStore = {
                metadata: {
                    delegationChain: [
                        { pubkey: "user-pubkey", displayName: "User", isUser: true },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false },
                    ],
                },
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => undefined,
            };
            mockConversationStoreGet.mockReturnValue(mockParentStore);

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");

            expect(result).toBeDefined();
            // Full chain validation: User -> pm-wip -> claude-code
            expect(result).toHaveLength(3);
            expect(result![0]).toEqual({ pubkey: "user-pubkey", displayName: "User", isUser: true });
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false });
            expect(result![2]).toEqual({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false });
        });

        it("should not have duplicate entries when merging stored chain with walked ancestors", () => {
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "exec-conv-id"]],
            } as unknown as NDKEvent;

            // Mock exec's conversation (has root event pointing to pm-conv)
            const mockExecStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => "exec-root-event",
            };

            const mockExecRootEvent = {
                tags: [["delegation", "pm-conv-id"]],
            };

            // Mock pm's conversation with stored chain
            const mockPmStore = {
                metadata: {
                    delegationChain: [
                        { pubkey: "user-pubkey", displayName: "User", isUser: true },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false },
                    ],
                },
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => undefined,
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "exec-conv-id") return mockExecStore;
                if (convId === "pm-conv-id") return mockPmStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "exec-root-event") return mockExecRootEvent;
                return undefined;
            });

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");

            expect(result).toBeDefined();

            // Verify no duplicates by checking pubkeys are unique
            const pubkeys = result!.map(e => e.pubkey);
            const uniquePubkeys = new Set(pubkeys);
            expect(pubkeys.length).toBe(uniquePubkeys.size);

            // Verify correct order: User first, current agent last
            expect(result![0].displayName).toBe("User");
            expect(result![0].isUser).toBe(true);
            expect(result![result!.length - 1].displayName).toBe("claude-code");
        });

        it("should handle missing parent conversation gracefully", () => {
            const event = {
                pubkey: "agent-pubkey-pm",
                tags: [["delegation", "missing-parent-id"]],
            } as unknown as NDKEvent;

            mockConversationStoreGet.mockReturnValue(undefined);

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");

            expect(result).toBeDefined();
            // When parent is missing, use sender as first in chain
            expect(result).toHaveLength(2);
            expect(result![0].displayName).toBe("pm-wip");
            expect(result![1].displayName).toBe("claude-code");
        });

        it("should identify User when sender is project owner", () => {
            const event = {
                pubkey: "project-owner-pubkey",
                tags: [["delegation", "parent-conv-id"]],
            } as unknown as NDKEvent;

            mockConversationStoreGet.mockReturnValue(undefined);

            const result = buildDelegationChain(event, "agent-pubkey-claude", "project-owner-pubkey");

            expect(result).toBeDefined();
            expect(result).toHaveLength(2);
            expect(result![0]).toEqual({ pubkey: "project-owner-pubkey", displayName: "User", isUser: true });
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false });
        });

        it("should walk up multi-level delegation chains with correct full ordering", () => {
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "exec-conv-id"]],
            } as unknown as NDKEvent;

            // Mock the execution-coordinator's conversation (has no stored chain, but has root event)
            const mockExecStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => "exec-root-event",
            };

            // Mock the cached root event for exec conversation (points to pm-conv)
            const mockExecRootEvent = {
                tags: [["delegation", "pm-conv-id"]],
            };

            // Mock pm-wip's conversation (has stored chain starting from User)
            const mockPmStore = {
                metadata: {
                    delegationChain: [
                        { pubkey: "user-pubkey", displayName: "User", isUser: true },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false },
                    ],
                },
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => undefined,
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "exec-conv-id") return mockExecStore;
                if (convId === "pm-conv-id") return mockPmStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "exec-root-event") return mockExecRootEvent;
                return undefined;
            });

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");

            expect(result).toBeDefined();
            // Full chain should be: User -> pm-wip -> exec -> claude-code
            expect(result).toHaveLength(4);
            expect(result![0]).toEqual({ pubkey: "user-pubkey", displayName: "User", isUser: true });
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false });
            expect(result![2]).toEqual({ pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false });
            expect(result![3]).toEqual({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false });

            // Verify no duplicates
            const pubkeys = result!.map(e => e.pubkey);
            const uniquePubkeys = new Set(pubkeys);
            expect(pubkeys.length).toBe(uniquePubkeys.size);
        });

        it("should include immediate delegator in legacy path (parent exists but no stored chain)", () => {
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "legacy-parent-conv-id"]],
            } as unknown as NDKEvent;

            // Mock a legacy parent conversation with no stored delegationChain
            // but with messages - simulating an older conversation
            const mockLegacyParentStore = {
                metadata: {}, // No delegationChain - this is the legacy case
                getAllMessages: () => [{ pubkey: "user-pubkey" }], // User started this conv
                getRootEventId: () => "legacy-root-event",
            };

            // Root event has no further delegation tag - this is the origin
            const mockLegacyRootEvent = {
                tags: [], // No delegation tag - user started it
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "legacy-parent-conv-id") return mockLegacyParentStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "legacy-root-event") return mockLegacyRootEvent;
                return undefined;
            });

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");

            expect(result).toBeDefined();
            // Chain should include: User (from walking up) -> exec (immediate delegator) -> claude-code (current)
            expect(result).toHaveLength(3);
            expect(result![0]).toEqual({ pubkey: "user-pubkey", displayName: "User", isUser: true });
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false });
            expect(result![2]).toEqual({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false });

            // Verify no duplicates
            const pubkeys = result!.map(e => e.pubkey);
            const uniquePubkeys = new Set(pubkeys);
            expect(pubkeys.length).toBe(uniquePubkeys.size);
        });

        it("should prevent infinite loops with visited set", () => {
            const event = {
                pubkey: "agent-pubkey-pm",
                tags: [["delegation", "conv-a"]],
            } as unknown as NDKEvent;

            // Create a circular reference: conv-a -> conv-b -> conv-a
            const mockStoreA = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-exec" }],
                getRootEventId: () => "event-a",
            };

            const mockStoreB = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => "event-b",
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "conv-a") return mockStoreA;
                if (convId === "conv-b") return mockStoreB;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "event-a") return { tags: [["delegation", "conv-b"]] };
                if (eventId === "event-b") return { tags: [["delegation", "conv-a"]] };
                return undefined;
            });

            // Should not hang, should return a chain without duplicates
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");
            expect(result).toBeDefined();

            // Verify no duplicates from circular reference
            const pubkeys = result!.map(e => e.pubkey);
            const uniquePubkeys = new Set(pubkeys);
            expect(pubkeys.length).toBe(uniquePubkeys.size);
        });

        it("should use truncated pubkey for unknown agents", () => {
            const event = {
                pubkey: "unknown123456789abcdef",
                tags: [["delegation", "parent-conv-id"]],
            } as unknown as NDKEvent;

            mockConversationStoreGet.mockReturnValue(undefined);

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");

            expect(result).toBeDefined();
            expect(result).toHaveLength(2);
            // Full order validation: unknown first, current agent last
            expect(result![0].displayName).toBe("unknown1");
            expect(result![1].displayName).toBe("claude-code");
        });
    });
});
