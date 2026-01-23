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
        it("should format a simple two-entry chain with conversation IDs", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "agent-pubkey", displayName: "claude-code", isUser: false, conversationId: "abc123def456" },
            ];

            const result = formatDelegationChain(chain, "agent-pubkey", "current123456");
            expect(result).toBe("[User -> claude-code (you)] [conversation abc123def456]");
        });

        it("should format a longer delegation chain with indentation", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false, conversationId: "conv1234abcd" },
                { pubkey: "exec-pubkey", displayName: "execution-coordinator", isUser: false, conversationId: "conv5678efgh" },
                { pubkey: "claude-pubkey", displayName: "claude-code", isUser: false, conversationId: "conv9012ijkl" },
            ];

            const result = formatDelegationChain(chain, "claude-pubkey", "current123456");
            const expected = `[User -> pm-wip] [conversation conv1234abcd]
  -> [pm-wip -> execution-coordinator] [conversation conv5678efgh]
    -> [execution-coordinator -> claude-code (you)] [conversation conv9012ijkl]`;
            expect(result).toBe(expected);
        });

        it("should mark current agent with (you) correctly", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false, conversationId: "conv1234abcd" },
            ];

            const result = formatDelegationChain(chain, "pm-pubkey", "current123456");
            expect(result).toBe("[User -> pm-wip (you)] [conversation conv1234abcd]");
        });

        it("should handle empty chain gracefully", () => {
            const result = formatDelegationChain([], "some-pubkey");
            expect(result).toBe("");
        });

        it("should handle chain with unknown current agent", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "agent-pubkey", displayName: "agent", isUser: false, conversationId: "conv1234abcd" },
            ];

            const result = formatDelegationChain(chain, "different-pubkey", "current123456");
            expect(result).toBe("[User -> agent] [conversation conv1234abcd]");
        });

        it("should use currentConversationId when entry has no conversationId", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "agent-pubkey", displayName: "claude-code", isUser: false }, // no conversationId
            ];

            const result = formatDelegationChain(chain, "agent-pubkey", "currentconv12345678");
            // "currentconv12345678" truncated to 12 chars is "currentconv1"
            expect(result).toBe("[User -> claude-code (you)] [conversation currentconv1]");
        });

        it("should use 'unknown' when no conversation ID is available", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "agent-pubkey", displayName: "claude-code", isUser: false },
            ];

            const result = formatDelegationChain(chain, "agent-pubkey");
            expect(result).toBe("[User -> claude-code (you)] [conversation unknown]");
        });

        it("should handle single entry chain", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true, conversationId: "single12conv" },
            ];

            const result = formatDelegationChain(chain, "different-pubkey", "current123456");
            expect(result).toBe("[User] [conversation single12conv]");
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
                        { pubkey: "user-pubkey", displayName: "User", isUser: true, conversationId: "origconv1234" },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "pmconv123456" },
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
            expect(result![0]).toMatchObject({ pubkey: "user-pubkey", displayName: "User", isUser: true });
            expect(result![0].conversationId).toBe("origconv1234"); // preserved from stored chain
            expect(result![1]).toMatchObject({ pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false });
            expect(result![1].conversationId).toBe("pmconv123456"); // preserved from stored chain
            expect(result![2]).toMatchObject({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false });
            // Current agent doesn't have a conversationId - it's the "current" conversation passed separately to formatDelegationChain
            expect(result![2].conversationId).toBeUndefined();
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
            // No conversationId at build time - the immediate delegator's delegatee conversation
            // is the CURRENT conversation, which is passed to formatDelegationChain
            expect(result![0].conversationId).toBeUndefined();
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
            expect(result![0]).toMatchObject({ pubkey: "project-owner-pubkey", displayName: "User", isUser: true });
            // No conversationId at build time - the immediate delegator's delegatee conversation
            // is the CURRENT conversation, which is passed to formatDelegationChain
            expect(result![0].conversationId).toBeUndefined();
            expect(result![1]).toMatchObject({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false });
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
                        { pubkey: "user-pubkey", displayName: "User", isUser: true, conversationId: "origconv1234" },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "pmconv123456" },
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
            expect(result![0]).toMatchObject({ pubkey: "user-pubkey", displayName: "User", isUser: true });
            expect(result![1]).toMatchObject({ pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false });
            expect(result![2]).toMatchObject({ pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false });
            expect(result![3]).toMatchObject({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false });

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
            expect(result![0]).toMatchObject({ pubkey: "user-pubkey", displayName: "User", isUser: true });
            // User delegated to create the legacy parent conversation
            expect(result![0].conversationId).toBe("legacy-paren"); // truncated to 12 chars
            expect(result![1]).toMatchObject({ pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false });
            // Exec is the immediate delegator - their delegatee (claude) is in the CURRENT conversation,
            // which is not known at build time (passed to formatDelegationChain)
            expect(result![1].conversationId).toBeUndefined();
            expect(result![2]).toMatchObject({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false });

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
            // Immediate delegator - their delegatee (current agent) is in the CURRENT conversation
            expect(result![0].conversationId).toBeUndefined();
            expect(result![1].displayName).toBe("claude-code");
        });

        it("should include conversation ID only for entries discovered by walking up", () => {
            const event = {
                pubkey: "agent-pubkey-pm",
                tags: [["delegation", "parent123456789"]],
            } as unknown as NDKEvent;

            mockConversationStoreGet.mockReturnValue(undefined);

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");

            expect(result).toBeDefined();
            expect(result).toHaveLength(2);
            // Immediate delegator doesn't have conversationId - their delegatee is in CURRENT conversation
            expect(result![0].conversationId).toBeUndefined();
            expect(result![1].conversationId).toBeUndefined(); // Current agent doesn't have a conversationId
        });

        it("should correctly align conversation IDs in multi-hop chain", () => {
            // Scenario: User -> pm (conv-pm) -> exec (conv-exec) -> claude (current)
            // Each conversation ID represents the DELEGATEE's conversation
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "conv-exec-123"]],
            } as unknown as NDKEvent;

            // Mock exec's conversation (no stored chain, points to pm's conv)
            const mockExecStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => "exec-root-event",
            };

            // Mock pm's conversation (no stored chain, points to user's conv)
            const mockPmStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => "pm-root-event",
            };

            // User's conversation (origin - no delegation tag)
            const mockUserStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => "user-root-event",
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "conv-exec-123") return mockExecStore;
                if (convId === "conv-pm-12345") return mockPmStore;
                if (convId === "conv-user-1234") return mockUserStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "exec-root-event") return { tags: [["delegation", "conv-pm-12345"]] };
                if (eventId === "pm-root-event") return { tags: [["delegation", "conv-user-1234"]] };
                if (eventId === "user-root-event") return { tags: [] }; // No delegation - origin
                return undefined;
            });

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");

            expect(result).toBeDefined();
            expect(result).toHaveLength(4);

            // User initiated conv-user (delegated to pm who created conv-pm)
            // So User's delegatee conversation is conv-pm
            expect(result![0]).toMatchObject({ displayName: "User", isUser: true });
            expect(result![0].conversationId).toBe("conv-pm-12345".substring(0, 12));

            // pm initiated conv-pm (delegated to exec who created conv-exec)
            // So pm's delegatee conversation is conv-exec
            expect(result![1]).toMatchObject({ displayName: "pm-wip" });
            expect(result![1].conversationId).toBe("conv-exec-123".substring(0, 12));

            // exec is the immediate delegator - delegatee is claude in CURRENT conversation
            expect(result![2]).toMatchObject({ displayName: "execution-coordinator" });
            expect(result![2].conversationId).toBeUndefined(); // Filled by formatDelegationChain

            // claude is current agent - no conversationId
            expect(result![3]).toMatchObject({ displayName: "claude-code" });
            expect(result![3].conversationId).toBeUndefined();
        });

        it("should correctly use parent-chain when available", () => {
            // Scenario: Parent conversation already has a stored chain
            // We should reuse it and extend with current delegation
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "exec-conv-id"]],
            } as unknown as NDKEvent;

            // Mock exec's conversation with a stored chain
            const mockExecStore = {
                metadata: {
                    delegationChain: [
                        { pubkey: "user-pubkey", displayName: "User", isUser: true, conversationId: "userconv1234" },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "pmconv123456" },
                        { pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false, conversationId: "execconv1234" },
                    ],
                },
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => undefined,
            };

            mockConversationStoreGet.mockReturnValue(mockExecStore);

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey");

            expect(result).toBeDefined();
            expect(result).toHaveLength(4);

            // Stored chain entries should have their conversation IDs preserved
            expect(result![0]).toMatchObject({ displayName: "User", isUser: true, conversationId: "userconv1234" });
            expect(result![1]).toMatchObject({ displayName: "pm-wip", conversationId: "pmconv123456" });
            expect(result![2]).toMatchObject({ displayName: "execution-coordinator", conversationId: "execconv1234" });

            // Current agent added at the end
            expect(result![3]).toMatchObject({ displayName: "claude-code" });
            expect(result![3].conversationId).toBeUndefined();
        });

        it("should format multi-hop chain with correct conversation IDs", () => {
            // Test that formatDelegationChain correctly uses the conversation IDs
            // Each entry's conversationId represents the conversation THEY are the delegatee in
            // (i.e., the conversation created when the previous agent delegated to them)
            // Note: buildDelegationChain stores already-truncated IDs, so use 12-char IDs in test data
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true }, // User has no conversationId (origin)
                { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "pmconv123456" }, // 12 chars
                { pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false, conversationId: "execconv1234" }, // 12 chars
                { pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false }, // No conversationId - current conversation
            ];

            const result = formatDelegationChain(chain, "agent-pubkey-claude", "currentconv123456789");

            // Verify each line has the correct conversation ID
            const lines = result.split("\n");
            expect(lines).toHaveLength(3);

            // User -> pm: uses pm's conversationId (pm is the "to" entry)
            expect(lines[0]).toContain("[conversation pmconv123456]");

            // pm -> exec: uses exec's conversationId (exec is the "to" entry)
            expect(lines[1]).toContain("[conversation execconv1234]");

            // exec -> claude (last hop): uses currentConversationId since claude has no conversationId
            expect(lines[2]).toContain("[conversation currentconv1]"); // truncated to 12 chars
            expect(lines[2]).toContain("(you)");
        });

        it("should use 'unknown' for missing conversation IDs in middle hops", () => {
            // If a middle hop is missing conversationId, should show "unknown" not currentConversationId
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true }, // No conversationId
                { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false }, // No conversationId
                { pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false },
            ];

            const result = formatDelegationChain(chain, "agent-pubkey-claude", "currentconv123");

            const lines = result.split("\n");
            expect(lines).toHaveLength(2);

            // First hop (User -> pm) - missing conversationId on pm, NOT last hop, so "unknown"
            expect(lines[0]).toContain("[conversation unknown]");

            // Last hop (pm -> claude) - missing conversationId but IS last hop, so uses currentConversationId
            expect(lines[1]).toContain("[conversation currentconv1]");
        });
    });
});
