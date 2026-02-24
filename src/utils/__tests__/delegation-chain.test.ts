import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatDelegationChain, wouldCreateCircularDelegation, buildDelegationChain } from "../delegation-chain";
import { shortenConversationId } from "../conversation-id";
import type { DelegationChainEntry } from "@/conversations/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock functions that will be used by the mocked modules
const mockConversationStoreGet = vi.fn();
const mockConversationStoreGetCachedEvent = vi.fn();
const mockGetNameSync = vi.fn();

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

vi.mock("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getNameSync: (pubkey: string) => mockGetNameSync(pubkey),
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
    describe("shortenConversationId", () => {
        it("should truncate to 12 characters", () => {
            expect(shortenConversationId("4f69d3302cf2abcdef123456")).toBe("4f69d3302cf2");
        });

        it("should handle short IDs gracefully", () => {
            expect(shortenConversationId("abc")).toBe("abc");
        });

        it("should handle exactly 12 characters", () => {
            expect(shortenConversationId("4f69d3302cf2")).toBe("4f69d3302cf2");
        });
    });

    describe("formatDelegationChain", () => {
        it("should format a simple two-entry chain with conversation ID", () => {
            // SEMANTICS: conversationId = "where this agent was delegated TO"
            // claude-code was delegated to in "abc123def456789" (full ID stored)
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "agent-pubkey", displayName: "claude-code", isUser: false, conversationId: "abc123def456789" },
            ];

            const result = formatDelegationChain(chain, "agent-pubkey");
            // [User -> claude-code] uses recipient.conversationId (truncated to 12 chars for display)
            expect(result).toBe("[User -> claude-code (you)] [conversation abc123def456]");
        });

        it("should format a longer delegation chain with multi-line tree format", () => {
            // SEMANTICS: conversationId = "where this agent was delegated TO"
            // User is origin (no conversationId)
            // Full conversation IDs are stored in entries
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false, conversationId: "conv1abc123456789" },
                { pubkey: "exec-pubkey", displayName: "execution-coordinator", isUser: false, conversationId: "conv2def567890123" },
                { pubkey: "claude-pubkey", displayName: "claude-code", isUser: false, conversationId: "conv3ghi901234567" },
            ];

            const result = formatDelegationChain(chain, "claude-pubkey");
            const lines = result.split("\n");

            expect(lines).toHaveLength(3);
            // Each link uses RECIPIENT.conversationId (truncated to 12 chars for display)
            expect(lines[0]).toBe("[User -> pm-wip] [conversation conv1abc1234]");
            expect(lines[1]).toBe("  -> [pm-wip -> execution-coordinator] [conversation conv2def5678]");
            expect(lines[2]).toBe("    -> [execution-coordinator -> claude-code (you)] [conversation conv3ghi9012]");
        });

        it("should mark current agent with (you) correctly", () => {
            // SEMANTICS: pm-wip was delegated to in conv123abc123456789 (full ID stored)
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false, conversationId: "conv123abc123456789" },
            ];

            const result = formatDelegationChain(chain, "pm-pubkey");
            // Uses recipient.conversationId (truncated to 12 chars)
            expect(result).toBe("[User -> pm-wip (you)] [conversation conv123abc12]");
        });

        it("should handle empty chain gracefully", () => {
            const result = formatDelegationChain([], "some-pubkey");
            expect(result).toBe("");
        });

        it("should handle chain with unknown current agent", () => {
            // SEMANTICS: agent was delegated to in conv123abc123456789 (full ID stored)
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "agent-pubkey", displayName: "agent", isUser: false, conversationId: "conv123abc123456789" },
            ];

            const result = formatDelegationChain(chain, "different-pubkey");
            // Uses recipient.conversationId (truncated to 12 chars)
            expect(result).toBe("[User -> agent] [conversation conv123abc12]");
        });

        it("should show 'unknown' for missing conversation IDs (backward compatibility)", () => {
            // SEMANTICS: conversationId = "where this agent was delegated TO"
            // If an entry doesn't have conversationId, show "unknown" for that link
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false }, // No conversationId
                { pubkey: "claude-pubkey", displayName: "claude-code", isUser: false }, // No conversationId
            ];

            const result = formatDelegationChain(chain, "claude-pubkey");
            const lines = result.split("\n");

            expect(lines).toHaveLength(2);
            // pm-wip has no conversationId -> unknown
            expect(lines[0]).toBe("[User -> pm-wip] [conversation unknown]");
            // claude-code has no conversationId -> unknown
            expect(lines[1]).toBe("  -> [pm-wip -> claude-code (you)] [conversation unknown]");
        });

        it("should use recipient.conversationId for each link", () => {
            // SEMANTICS: conversationId = "where this agent was delegated TO"
            // Full conversation IDs are stored in entries
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pubkey", displayName: "User", isUser: true },
                { pubkey: "pm-pubkey", displayName: "pm-wip", isUser: false, conversationId: "userconv1234567890" },
                { pubkey: "claude-pubkey", displayName: "claude-code", isUser: false, conversationId: "pmconv12345678901234" },
            ];

            const result = formatDelegationChain(chain, "claude-pubkey");
            const lines = result.split("\n");

            expect(lines).toHaveLength(2);
            // [User -> pm-wip] uses pm-wip.conversationId (truncated to 12 chars)
            expect(lines[0]).toBe("[User -> pm-wip] [conversation userconv1234]");
            // [pm-wip -> claude-code] uses claude-code.conversationId (truncated to 12 chars)
            expect(lines[1]).toBe("  -> [pm-wip -> claude-code (you)] [conversation pmconv123456]");
        });

        it("should handle single entry chain", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "agent-pubkey", displayName: "claude-code", isUser: false },
            ];

            const result = formatDelegationChain(chain, "agent-pubkey");
            expect(result).toBe("claude-code (you)");
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
            mockGetNameSync.mockReset();
            // Default behavior: return "User" for any pubkey (fallback behavior)
            mockGetNameSync.mockReturnValue("User");
        });

        afterEach(() => {
            mockConversationStoreGet.mockReset();
            mockConversationStoreGetCachedEvent.mockReset();
            mockGetNameSync.mockReset();
        });

        it("should return undefined for direct user messages (no delegation tag)", () => {
            const event = {
                pubkey: "user-pubkey",
                tags: [],
            } as unknown as NDKEvent;

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "any-conv-id");
            expect(result).toBeUndefined();
        });

        it("should build chain with correct ordering: User first, current agent last", () => {
            const event = {
                pubkey: "agent-pubkey-pm",
                tags: [["delegation", "parent-conv-id-1234567890"]],
            } as unknown as NDKEvent;

            // Mock parent conversation with stored chain starting from User
            // SEMANTICS: conversationId = "where this agent was delegated TO"
            // Full conversation IDs are stored
            const mockParentStore = {
                metadata: {
                    delegationChain: [
                        { pubkey: "user-pubkey", displayName: "User", isUser: true },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "userconv1234567890" },
                    ],
                },
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => undefined,
            };
            mockConversationStoreGet.mockReturnValue(mockParentStore);

            // Pass currentConversationId to indicate the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            // Full chain validation: User -> pm-wip -> claude-code
            // SEMANTICS: conversationId = "where this agent was delegated TO" (full IDs stored)
            // User: origin, no conversationId
            // pm-wip: from stored chain, conversationId = userconv1234567890
            // claude-code: delegated to in claude-conv-id-1234567890 (the conversation created for them)
            expect(result).toHaveLength(3);
            expect(result![0]).toEqual({ pubkey: "user-pubkey", displayName: "User", isUser: true });
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "userconv1234567890" });
            expect(result![2]).toEqual({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false, conversationId: "claude-conv-id-1234567890" });
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

            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");

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
                tags: [["delegation", "missing-parent-id-1234567890"]],
            } as unknown as NDKEvent;

            mockConversationStoreGet.mockReturnValue(undefined);

            // Pass currentConversationId for the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            // When parent is missing, use sender as first in chain
            // SEMANTICS: conversationId = "where this agent was delegated TO" (full IDs stored)
            // pm-wip: origin (chain is empty), no conversationId
            // claude-code: delegated to in claude-conv-id-1234567890 (the conversation created for them)
            expect(result).toHaveLength(2);
            expect(result![0].displayName).toBe("pm-wip");
            expect(result![0].conversationId).toBeUndefined(); // Origin has no conversationId
            expect(result![1].displayName).toBe("claude-code");
            expect(result![1].conversationId).toBe("claude-conv-id-1234567890"); // The conversation created for claude
        });

        it("should identify User when sender is project owner", () => {
            const event = {
                pubkey: "project-owner-pubkey",
                tags: [["delegation", "parent-conv-id-1234567890"]],
            } as unknown as NDKEvent;

            mockConversationStoreGet.mockReturnValue(undefined);

            // Pass currentConversationId for the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "project-owner-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            // SEMANTICS: conversationId = "where this agent was delegated TO" (full IDs stored)
            // User: origin, no conversationId
            // claude-code: delegated to in claude-conv-id-1234567890 (the conversation created for them)
            expect(result).toHaveLength(2);
            expect(result![0]).toEqual({ pubkey: "project-owner-pubkey", displayName: "User", isUser: true }); // Origin has no conversationId
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false, conversationId: "claude-conv-id-1234567890" }); // Current conv ID
        });

        it("should use PubkeyService to resolve user display name from Nostr profile", () => {
            const event = {
                pubkey: "project-owner-pubkey",
                tags: [["delegation", "parent-conv-id-1234567890"]],
            } as unknown as NDKEvent;

            mockConversationStoreGet.mockReturnValue(undefined);
            // Mock PubkeyService returning a real user name instead of fallback "User"
            mockGetNameSync.mockReturnValue("Pablo");

            // Pass currentConversationId for the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "project-owner-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            expect(result).toHaveLength(2);
            // Should use "Pablo" from PubkeyService instead of hardcoded "User"
            expect(result![0]).toEqual({ pubkey: "project-owner-pubkey", displayName: "Pablo", isUser: true });
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false, conversationId: "claude-conv-id-1234567890" });
            // Verify PubkeyService was called with the project owner pubkey
            expect(mockGetNameSync).toHaveBeenCalledWith("project-owner-pubkey");
        });

        it("should walk up multi-level delegation chains with correct full ordering", () => {
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "exec-conv-id-1234567890"]],
            } as unknown as NDKEvent;

            // Mock the execution-coordinator's conversation (has no stored chain, but has root event)
            const mockExecStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => "exec-root-event",
            };

            // Mock the cached root event for exec conversation (points to pm-conv)
            const mockExecRootEvent = {
                tags: [["delegation", "pm-conv-id-1234567890"]],
            };

            // Mock pm-wip's conversation (has stored chain starting from User)
            // SEMANTICS: conversationId = "where this agent was delegated TO" (full IDs stored)
            // User: origin, no conversationId
            // pm-wip: was delegated to in userconv1234567890
            const mockPmStore = {
                metadata: {
                    delegationChain: [
                        { pubkey: "user-pubkey", displayName: "User", isUser: true },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "userconv1234567890" },
                    ],
                },
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => undefined,
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "exec-conv-id-1234567890") return mockExecStore;
                if (convId === "pm-conv-id-1234567890") return mockPmStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "exec-root-event") return mockExecRootEvent;
                return undefined;
            });

            // Pass currentConversationId for the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            // Full chain should be: User -> pm-wip -> exec -> claude-code
            // SEMANTICS: conversationId = "where this agent was delegated TO" (full IDs stored)
            // User: origin, no conversationId
            // pm-wip: from stored chain, conversationId = userconv1234567890
            // exec: delegated to in pm-conv-id-1234567890
            // claude-code: delegated to in claude-conv-id-1234567890 (the conversation created for them)
            expect(result).toHaveLength(4);
            expect(result![0]).toEqual({ pubkey: "user-pubkey", displayName: "User", isUser: true }); // Origin, no convId
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "userconv1234567890" }); // From stored chain
            expect(result![2]).toEqual({ pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false, conversationId: "pm-conv-id-1234567890" }); // Full ID
            expect(result![3]).toEqual({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false, conversationId: "claude-conv-id-1234567890" }); // Current conv ID

            // Verify no duplicates
            const pubkeys = result!.map(e => e.pubkey);
            const uniquePubkeys = new Set(pubkeys);
            expect(pubkeys.length).toBe(uniquePubkeys.size);
        });

        it("should include immediate delegator in legacy path (parent exists but no stored chain)", () => {
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "legacy-parent-conv-id-1234567890"]],
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
                if (convId === "legacy-parent-conv-id-1234567890") return mockLegacyParentStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "legacy-root-event") return mockLegacyRootEvent;
                return undefined;
            });

            // Pass currentConversationId for the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            // Chain should include: User (from walking up) -> exec (immediate delegator) -> claude-code (current)
            // SEMANTICS: conversationId = "where this agent was delegated TO" (full IDs stored)
            // User: origin (started the conversation), no conversationId
            // exec: delegated to in legacy-parent-conv-id-1234567890
            // claude-code: delegated to in claude-conv-id-1234567890 (the conversation created for them)
            expect(result).toHaveLength(3);
            expect(result![0]).toEqual({ pubkey: "user-pubkey", displayName: "User", isUser: true }); // Origin, no convId
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false, conversationId: "legacy-parent-conv-id-1234567890" }); // Full ID
            expect(result![2]).toEqual({ pubkey: "agent-pubkey-claude", displayName: "claude-code", isUser: false, conversationId: "claude-conv-id-1234567890" }); // Current conv ID

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
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");
            expect(result).toBeDefined();

            // Verify no duplicates from circular reference
            const pubkeys = result!.map(e => e.pubkey);
            const uniquePubkeys = new Set(pubkeys);
            expect(pubkeys.length).toBe(uniquePubkeys.size);
        });

        // Integration test: validates buildDelegationChain + formatDelegationChain end-to-end
        it("integration: should produce correct formatted output with proper conversation IDs", () => {
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "exec-conv-id-1234567890"]],
            } as unknown as NDKEvent;

            // Mock the execution-coordinator's conversation
            const mockExecStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => "exec-root-event",
            };

            // Mock the cached root event for exec conversation (points to pm-conv)
            const mockExecRootEvent = {
                tags: [["delegation", "pm-conv-id-1234567890"]],
            };

            // Mock pm-wip's conversation with stored chain (correct semantics)
            // SEMANTICS: conversationId = "where this agent was delegated TO" (full IDs stored)
            const mockPmStore = {
                metadata: {
                    delegationChain: [
                        { pubkey: "user-pubkey", displayName: "User", isUser: true }, // Origin
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "userconv1234567890" }, // Full ID
                    ],
                },
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => undefined,
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "exec-conv-id-1234567890") return mockExecStore;
                if (convId === "pm-conv-id-1234567890") return mockPmStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "exec-root-event") return mockExecRootEvent;
                return undefined;
            });

            // Build the chain with currentConversationId for the conversation being created for claude-code
            const chain = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");
            expect(chain).toBeDefined();
            expect(chain).toHaveLength(4);

            // Verify full conversation IDs are stored in the chain
            expect(chain![0].conversationId).toBeUndefined(); // User is origin
            expect(chain![1].conversationId).toBe("userconv1234567890"); // Full ID from stored chain
            expect(chain![2].conversationId).toBe("pm-conv-id-1234567890"); // Full ID
            expect(chain![3].conversationId).toBe("claude-conv-id-1234567890"); // Current conv ID

            // Format the chain (no currentConversationId needed - it uses stored IDs)
            const formatted = formatDelegationChain(chain!, "agent-pubkey-claude");

            // Verify the formatted output has correct structure and conversation IDs
            // SEMANTICS: [A -> B] shows B.conversationId (truncated to 12 chars for display)
            const lines = formatted.split("\n");
            expect(lines).toHaveLength(3);

            // Line 1: [User -> pm-wip] uses pm-wip.conversationId (truncated)
            expect(lines[0]).toBe("[User -> pm-wip] [conversation userconv1234]");

            // Line 2: [pm-wip -> execution-coordinator] uses exec.conversationId (truncated)
            expect(lines[1]).toBe("  -> [pm-wip -> execution-coordinator] [conversation pm-conv-id-1]");

            // Line 3: [execution-coordinator -> claude-code (you)] uses claude.conversationId (truncated)
            expect(lines[2]).toBe("    -> [execution-coordinator -> claude-code (you)] [conversation claude-conv-]");
        });

        it("should allow self-delegation: agent appears as both delegator and current agent", () => {
            // When agent-pubkey-exec delegates to itself, the chain must have exec appearing twice:
            // once as the delegator and once as the terminal current-agent entry.
            // This ensures resolveCompletionRecipient picks chain[length-2] = exec (the delegator),
            // NOT the project owner.
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "exec-parent-conv-id-1234567890"]],
            } as unknown as NDKEvent;

            // Mock parent conversation with stored chain ending at exec
            const mockParentStore = {
                metadata: {
                    delegationChain: [
                        { pubkey: "user-pubkey", displayName: "User", isUser: true },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "userconv1234567890" },
                        { pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false, conversationId: "pmconv1234567890" },
                    ],
                },
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => undefined,
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "exec-parent-conv-id-1234567890") return mockParentStore;
                return undefined;
            });

            // Self-delegation: currentAgentPubkey === event.pubkey
            const result = buildDelegationChain(
                event,
                "agent-pubkey-exec", // current agent is exec (same as event.pubkey)
                "user-pubkey",
                "self-deleg-conv-id-1234567890"
            );

            expect(result).toBeDefined();
            // Chain: User -> pm-wip -> exec(delegator) -> exec(current)
            // exec MUST appear twice
            expect(result).toHaveLength(4);
            expect(result![0]).toEqual({ pubkey: "user-pubkey", displayName: "User", isUser: true });
            expect(result![1]).toEqual({ pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "userconv1234567890" });
            expect(result![2]).toEqual({ pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false, conversationId: "pmconv1234567890" });
            expect(result![3]).toEqual({ pubkey: "agent-pubkey-exec", displayName: "execution-coordinator", isUser: false, conversationId: "self-deleg-conv-id-1234567890" });

            // Verify resolveCompletionRecipient logic: chain[length-2] should be the delegator (exec)
            expect(result![result!.length - 2].pubkey).toBe("agent-pubkey-exec");
        });

        it("should use truncated pubkey for unknown agents", () => {
            const event = {
                pubkey: "unknown123456789abcdef",
                tags: [["delegation", "parent-conv-id"]],
            } as unknown as NDKEvent;

            mockConversationStoreGet.mockReturnValue(undefined);

            // Pass currentConversationId for the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            expect(result).toHaveLength(2);
            // Full order validation: unknown first (12-char prefix), current agent last
            expect(result![0].displayName).toBe("unknown12345"); // PREFIX_LENGTH=12
            expect(result![1].displayName).toBe("claude-code");
            expect(result![1].conversationId).toBe("claude-conv-id-1234567890"); // Current conv ID
        });

        it("should trust stored chains as authoritative (even with legacy format)", () => {
            // HISTORICAL NOTE: Legacy chains may have conversationId on the origin entry,
            // but we now trust stored chains as authoritative and don't re-compute them.
            // This simplifies the logic and the stored format is stable going forward.

            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "exec-conv-id-1234567890"]],
            } as unknown as NDKEvent;

            // Mock the execution-coordinator's conversation
            const mockExecStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => "exec-root-event",
            };

            // Mock the cached root event for exec conversation (points to pm-conv)
            const mockExecRootEvent = {
                tags: [["delegation", "pm-conv-id-1234567890"]],
            };

            // Mock pm-wip's conversation with a stored chain (even if it has legacy format)
            // The key point: stored chains are now trusted as authoritative
            const mockPmStore = {
                metadata: {
                    delegationChain: [
                        // Even if origin has conversationId (legacy format), we trust this stored chain
                        { pubkey: "user-pubkey", displayName: "User", isUser: true, conversationId: "legacy-conv-id" },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "user-conv-id-1234567890" },
                    ],
                },
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => "pm-root-event",
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "exec-conv-id-1234567890") return mockExecStore;
                if (convId === "pm-conv-id-1234567890") return mockPmStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "exec-root-event") return mockExecRootEvent;
                return undefined;
            });

            // Pass currentConversationId for the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            expect(result).toHaveLength(4);

            // The stored chain is trusted and used directly (including any legacy format quirks)
            // User entry is taken from stored chain as-is
            expect(result![0].displayName).toBe("User");
            expect(result![0].conversationId).toBe("legacy-conv-id"); // Stored value is preserved
            expect(result![0].isUser).toBe(true);

            // pm-wip from stored chain
            expect(result![1].displayName).toBe("pm-wip");
            expect(result![1].conversationId).toBe("user-conv-id-1234567890");

            // exec is the immediate delegator, added after using the stored chain
            expect(result![2].displayName).toBe("execution-coordinator");
            expect(result![2].conversationId).toBe("pm-conv-id-1234567890");

            // claude was delegated TO in claude-conv-id-1234567890 (the conversation created for them)
            expect(result![3].displayName).toBe("claude-code");
            expect(result![3].conversationId).toBe("claude-conv-id-1234567890");
        });

        it("should trust new-semantic chains where origin has no conversationId", () => {
            // NEW SEMANTICS: Origin entry does NOT have a conversationId.
            // This test verifies that valid new-semantic chains are trusted and used directly.

            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "exec-conv-id-1234567890"]],
            } as unknown as NDKEvent;

            // Mock the execution-coordinator's conversation
            const mockExecStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => "exec-root-event",
            };

            // Mock the cached root event for exec conversation (points to pm-conv)
            const mockExecRootEvent = {
                tags: [["delegation", "pm-conv-id-1234567890"]],
            };

            // Mock pm-wip's conversation with a NEW-SEMANTIC stored chain
            // NEW SEMANTICS: Origin (User) has NO conversationId - this is correct
            const mockPmStore = {
                metadata: {
                    delegationChain: [
                        // NEW: Origin has NO conversationId (correct semantics)
                        { pubkey: "user-pubkey", displayName: "User", isUser: true },
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "user-conv-id-1234567890" },
                    ],
                },
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => undefined,
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "exec-conv-id-1234567890") return mockExecStore;
                if (convId === "pm-conv-id-1234567890") return mockPmStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "exec-root-event") return mockExecRootEvent;
                return undefined;
            });

            // Pass currentConversationId for the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            expect(result).toHaveLength(4);

            // Verify the stored chain was used (not re-computed):
            // User from stored chain
            expect(result![0].displayName).toBe("User");
            expect(result![0].conversationId).toBeUndefined(); // Origin has no conversationId

            // pm-wip from stored chain
            expect(result![1].displayName).toBe("pm-wip");
            expect(result![1].conversationId).toBe("user-conv-id-1234567890"); // From stored chain

            // exec was delegated TO in pm-conv-id-1234567890
            expect(result![2].displayName).toBe("execution-coordinator");
            expect(result![2].conversationId).toBe("pm-conv-id-1234567890");

            // claude was delegated TO in claude-conv-id-1234567890 (the conversation created for them)
            expect(result![3].displayName).toBe("claude-code");
            expect(result![3].conversationId).toBe("claude-conv-id-1234567890");
        });

        it("should capture conversation IDs when walking the chain", () => {
            const event = {
                pubkey: "agent-pubkey-exec",
                tags: [["delegation", "exec-conv-id-1234567890"]],
            } as unknown as NDKEvent;

            // Mock the execution-coordinator's conversation
            const mockExecStore = {
                metadata: {},
                getAllMessages: () => [{ pubkey: "agent-pubkey-pm" }],
                getRootEventId: () => "exec-root-event",
            };

            // Mock the cached root event for exec conversation (points to pm-conv)
            const mockExecRootEvent = {
                tags: [["delegation", "pm-conv-id-1234567890"]],
            };

            // Mock pm-wip's conversation with stored chain
            // SEMANTICS: conversationId = "where this agent was delegated TO" (full IDs stored)
            // User: origin, no conversationId
            // pm-wip: was delegated to in user-conv-id-1234567890
            const mockPmStore = {
                metadata: {
                    delegationChain: [
                        { pubkey: "user-pubkey", displayName: "User", isUser: true }, // Origin, no convId
                        { pubkey: "agent-pubkey-pm", displayName: "pm-wip", isUser: false, conversationId: "user-conv-id-1234567890" },
                    ],
                },
                getAllMessages: () => [{ pubkey: "user-pubkey" }],
                getRootEventId: () => undefined,
            };

            mockConversationStoreGet.mockImplementation((convId: string) => {
                if (convId === "exec-conv-id-1234567890") return mockExecStore;
                if (convId === "pm-conv-id-1234567890") return mockPmStore;
                return undefined;
            });

            mockConversationStoreGetCachedEvent.mockImplementation((eventId: string) => {
                if (eventId === "exec-root-event") return mockExecRootEvent;
                return undefined;
            });

            // Pass currentConversationId for the conversation being created for claude-code
            const result = buildDelegationChain(event, "agent-pubkey-claude", "user-pubkey", "claude-conv-id-1234567890");

            expect(result).toBeDefined();
            expect(result).toHaveLength(4);

            // Verify chain entries have FULL conversation IDs based on semantics:
            // conversationId = "where this agent was delegated TO" (full IDs stored)
            // User: origin, no conversationId
            expect(result![0].conversationId).toBeUndefined();
            // pm-wip: delegated to in user-conv-id-1234567890 (from stored chain, full ID)
            expect(result![1].conversationId).toBe("user-conv-id-1234567890");
            // exec: delegated to in pm-conv-id-1234567890 (full ID)
            expect(result![2].conversationId).toBe("pm-conv-id-1234567890");
            // claude: delegated to in claude-conv-id-1234567890 (the conversation created for them)
            expect(result![3].conversationId).toBe("claude-conv-id-1234567890");
        });
    });
});
