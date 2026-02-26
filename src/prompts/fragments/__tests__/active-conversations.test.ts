import { afterEach, beforeEach, describe, expect, it, spyOn, mock } from "bun:test";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import type { DelegationChainEntry } from "@/conversations/types";
import { RALRegistry } from "@/services/ral/RALRegistry";
import {
    activeConversationsFragment,
    extractParentFromDelegationChain,
    buildConversationTree,
    sortTree,
    renderTree,
} from "../08-active-conversations";
import type { AgentInstance } from "@/agents/types";
import type { RALRegistryEntry } from "@/services/ral/types";
import * as PubkeyServiceModule from "@/services/PubkeyService";

// Mock agent for testing
const createMockAgent = (pubkey: string = "agent-pubkey-123"): AgentInstance =>
    ({
        pubkey,
        slug: "test-agent",
    }) as AgentInstance;

// Mock RAL entry factory
const createMockRalEntry = (overrides: Partial<RALRegistryEntry> = {}): RALRegistryEntry => {
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        ralNumber: 1,
        agentPubkey: "other-agent-pubkey",
        projectId: "test-project",
        conversationId: "conv-active-1",
        queuedInjections: [],
        isStreaming: true,
        activeTools: new Map(),
        createdAt: now - 60000, // 1 minute ago
        lastActivityAt: now - 5000, // 5 seconds ago
        accumulatedRuntime: 0,
        lastReportedRuntime: 0,
        ...overrides,
    };
};

// Mock conversation store with delegation chain support
const createMockStore = (overrides: Partial<{
    title: string;
    summary: string;
    messageCount: number;
    delegationChain: DelegationChainEntry[];
}> = {}) => ({
    getMetadata: () => ({
        title: overrides.title,
        summary: overrides.summary,
        delegationChain: overrides.delegationChain,
    }),
    getAllMessages: () => Array(overrides.messageCount ?? 5).fill({}),
});

describe("activeConversationsFragment", () => {
    const now = 1700000000000; // Fixed timestamp to prevent drift
    const projectId = "test-project";

    let getActiveEntriesForProjectSpy: ReturnType<typeof spyOn>;
    let conversationRegistryGetSpy: ReturnType<typeof spyOn>;
    let getPubkeyServiceSpy: ReturnType<typeof spyOn>;
    let dateNowSpy: ReturnType<typeof spyOn>;
    let mockPubkeyService: { getNameSync: ReturnType<typeof mock> };

    beforeEach(() => {
        // Freeze Date.now so production code and test timestamps stay in sync
        dateNowSpy = spyOn(Date, "now").mockReturnValue(now);

        // Mock RALRegistry.getActiveEntriesForProject
        getActiveEntriesForProjectSpy = spyOn(
            RALRegistry.getInstance(),
            "getActiveEntriesForProject"
        );

        // Mock conversationRegistry.get
        conversationRegistryGetSpy = spyOn(
            conversationRegistry,
            "get"
        );

        // Mock PubkeyService
        mockPubkeyService = {
            getNameSync: mock((pubkey: string) => `agent-${pubkey.substring(0, 8)}`),
        };
        getPubkeyServiceSpy = spyOn(PubkeyServiceModule, "getPubkeyService").mockReturnValue(mockPubkeyService as any);
    });

    afterEach(() => {
        dateNowSpy.mockRestore();
        getActiveEntriesForProjectSpy.mockRestore();
        conversationRegistryGetSpy.mockRestore();
        getPubkeyServiceSpy.mockRestore();
    });

    describe("basic functionality", () => {
        it("should return empty string when no project ID is provided", () => {
            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "current-conv",
                // No projectId
            });

            expect(result).toBe("");
            expect(getActiveEntriesForProjectSpy).not.toHaveBeenCalled();
        });

        it("should return empty string when no active conversations exist", () => {
            getActiveEntriesForProjectSpy.mockReturnValue([]);

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "current-conv",
                projectId,
            });

            expect(result).toBe("");
        });

        it("should include active conversations in output", () => {
            const ralEntry = createMockRalEntry({
                conversationId: "conv-active-1",
                agentPubkey: "working-agent-pubkey",
                isStreaming: true,
            });

            getActiveEntriesForProjectSpy.mockReturnValue([ralEntry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Active Task",
                summary: "Working on feature X",
                messageCount: 10,
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("## Active Conversations");
            expect(result).toContain("**Active Task**");
            expect(result).toContain("Working on feature X");
            expect(result).toContain("(agent-working-");
        });
    });

    describe("exclusion of current conversation", () => {
        it("should exclude the current conversation from results", () => {
            const currentConvEntry = createMockRalEntry({
                conversationId: "current-conv",
                isStreaming: true,
            });
            const otherConvEntry = createMockRalEntry({
                conversationId: "other-active-conv",
                isStreaming: true,
            });

            getActiveEntriesForProjectSpy.mockReturnValue([currentConvEntry, otherConvEntry]);
            conversationRegistryGetSpy.mockImplementation((convId: string) => {
                if (convId === "other-active-conv") {
                    return createMockStore({ title: "Other Active Task" });
                }
                return createMockStore({ title: "Current Task" });
            });

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "current-conv",
                projectId,
            });

            expect(result).not.toContain("Current Task");
            expect(result).toContain("Other Active Task");
        });
    });

    describe("compact one-line format", () => {
        it("should render conversations in compact format with duration and last msg", () => {
            const entry = createMockRalEntry({
                conversationId: "conv-1",
                createdAt: now - 360000, // 6 minutes ago
                lastActivityAt: now - 120000, // 2 minutes ago
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Fix Bug",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Compact format: **Title** (agent) - duration, last msg X ago
            expect(result).toMatch(/\*\*Fix Bug\*\*.*-.*6m.*last msg.*2m ago/);
        });

        it("should not render multi-line ID/Status/Duration/Messages format", () => {
            const entry = createMockRalEntry();

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({ title: "Task" }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Old verbose format should NOT appear
            expect(result).not.toContain("- ID:");
            expect(result).not.toContain("- Status:");
            expect(result).not.toContain("- Duration:");
            expect(result).not.toContain("- Messages:");
        });

        it("should use truncated conversation ID when title is missing", () => {
            const entry = createMockRalEntry({
                conversationId: "abcdef1234567890",
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                // No title
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("Conversation abcdef12");
        });
    });

    describe("extractParentFromDelegationChain", () => {
        it("should return undefined for undefined chain", () => {
            expect(extractParentFromDelegationChain(undefined)).toBeUndefined();
        });

        it("should return undefined for empty chain", () => {
            expect(extractParentFromDelegationChain([])).toBeUndefined();
        });

        it("should return undefined for single-entry chain", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pk", displayName: "User", isUser: true, conversationId: "conv-1" },
            ];
            expect(extractParentFromDelegationChain(chain)).toBeUndefined();
        });

        it("should return the second-to-last entry's conversationId", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pk", displayName: "User", isUser: true, conversationId: "conv-root" },
                { pubkey: "pm-pk", displayName: "pm-agent", isUser: false, conversationId: "conv-pm" },
                { pubkey: "exec-pk", displayName: "exec-agent", isUser: false, conversationId: "conv-exec" },
            ];
            expect(extractParentFromDelegationChain(chain)).toBe("conv-pm");
        });

        it("should handle two-entry chain (return first entry)", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pk", displayName: "User", isUser: true, conversationId: "conv-root" },
                { pubkey: "agent-pk", displayName: "agent", isUser: false, conversationId: "conv-agent" },
            ];
            expect(extractParentFromDelegationChain(chain)).toBe("conv-root");
        });

        it("should return undefined when second-to-last entry has no conversationId", () => {
            const chain: DelegationChainEntry[] = [
                { pubkey: "user-pk", displayName: "User", isUser: true },
                { pubkey: "agent-pk", displayName: "agent", isUser: false, conversationId: "conv-agent" },
            ];
            expect(extractParentFromDelegationChain(chain)).toBeUndefined();
        });
    });

    describe("buildConversationTree", () => {
        it("should build a flat list when no parent relationships exist", () => {
            const entries = [
                { conversationId: "a", agentName: "agent-a", parentConversationId: undefined },
                { conversationId: "b", agentName: "agent-b", parentConversationId: undefined },
            ] as any[];

            const roots = buildConversationTree(entries);
            expect(roots.length).toBe(2);
            expect(roots[0].children.length).toBe(0);
            expect(roots[1].children.length).toBe(0);
        });

        it("should nest children under their parent", () => {
            const entries = [
                { conversationId: "parent", agentName: "pm", parentConversationId: undefined },
                { conversationId: "child", agentName: "exec", parentConversationId: "parent" },
            ] as any[];

            const roots = buildConversationTree(entries);
            expect(roots.length).toBe(1);
            expect(roots[0].entry.conversationId).toBe("parent");
            expect(roots[0].children.length).toBe(1);
            expect(roots[0].children[0].entry.conversationId).toBe("child");
        });

        it("should promote orphan to root when parent is not in active set", () => {
            const entries = [
                { conversationId: "orphan", agentName: "exec", parentConversationId: "missing-parent" },
                { conversationId: "other", agentName: "other", parentConversationId: undefined },
            ] as any[];

            const roots = buildConversationTree(entries);
            expect(roots.length).toBe(2);
            // Both should be root nodes
            const ids = roots.map(r => r.entry.conversationId);
            expect(ids).toContain("orphan");
            expect(ids).toContain("other");
        });

        it("should handle multi-level nesting", () => {
            const entries = [
                { conversationId: "root", agentName: "pm", parentConversationId: undefined },
                { conversationId: "mid", agentName: "exec", parentConversationId: "root" },
                { conversationId: "leaf", agentName: "dev", parentConversationId: "mid" },
            ] as any[];

            const roots = buildConversationTree(entries);
            expect(roots.length).toBe(1);
            expect(roots[0].children.length).toBe(1);
            expect(roots[0].children[0].children.length).toBe(1);
            expect(roots[0].children[0].children[0].entry.conversationId).toBe("leaf");
        });

        it("should handle multiple children under one parent", () => {
            const entries = [
                { conversationId: "parent", agentName: "pm", parentConversationId: undefined },
                { conversationId: "child-1", agentName: "exec", parentConversationId: "parent" },
                { conversationId: "child-2", agentName: "dev", parentConversationId: "parent" },
            ] as any[];

            const roots = buildConversationTree(entries);
            expect(roots.length).toBe(1);
            expect(roots[0].children.length).toBe(2);
        });

        it("should promote self-referential entries to root (cycle guard)", () => {
            const entries = [
                { conversationId: "self-ref", agentName: "agent", parentConversationId: "self-ref" },
                { conversationId: "normal", agentName: "other", parentConversationId: undefined },
            ] as any[];

            const roots = buildConversationTree(entries);
            expect(roots.length).toBe(2);
            const ids = roots.map(r => r.entry.conversationId);
            expect(ids).toContain("self-ref");
            expect(ids).toContain("normal");
        });
    });

    describe("sortTree", () => {
        it("should sort roots by max subtree activity (most recent first)", () => {
            const roots = [
                {
                    entry: { lastActivityAt: 100 } as any,
                    children: [],
                },
                {
                    entry: { lastActivityAt: 300 } as any,
                    children: [],
                },
                {
                    entry: { lastActivityAt: 200 } as any,
                    children: [],
                },
            ];

            const sorted = sortTree(roots);
            expect(sorted[0].entry.lastActivityAt).toBe(300);
            expect(sorted[1].entry.lastActivityAt).toBe(200);
            expect(sorted[2].entry.lastActivityAt).toBe(100);
        });

        it("should consider child activity when sorting roots", () => {
            const roots = [
                {
                    entry: { lastActivityAt: 100 } as any,
                    children: [
                        { entry: { lastActivityAt: 500 } as any, children: [] },
                    ],
                },
                {
                    entry: { lastActivityAt: 400 } as any,
                    children: [],
                },
            ];

            const sorted = sortTree(roots);
            // First root has child with activity at 500 > second root's 400
            expect(sorted[0].entry.lastActivityAt).toBe(100); // The parent of the active child
            expect(sorted[1].entry.lastActivityAt).toBe(400);
        });

        it("should sort children within a node", () => {
            const roots = [
                {
                    entry: { lastActivityAt: 100 } as any,
                    children: [
                        { entry: { lastActivityAt: 200, conversationId: "older" } as any, children: [] },
                        { entry: { lastActivityAt: 400, conversationId: "newer" } as any, children: [] },
                    ],
                },
            ];

            const sorted = sortTree(roots);
            expect(sorted[0].children[0].entry.conversationId).toBe("newer");
            expect(sorted[0].children[1].entry.conversationId).toBe("older");
        });

        it("should not mutate the original arrays", () => {
            const childA = { entry: { lastActivityAt: 200, conversationId: "a" } as any, children: [] };
            const childB = { entry: { lastActivityAt: 400, conversationId: "b" } as any, children: [] };
            const roots = [
                {
                    entry: { lastActivityAt: 300 } as any,
                    children: [childA, childB],
                },
                {
                    entry: { lastActivityAt: 100 } as any,
                    children: [],
                },
            ];

            // Capture original order
            const originalRootOrder = roots.map(r => r.entry.lastActivityAt);
            const originalChildOrder = roots[0].children.map(c => c.entry.conversationId);

            sortTree(roots);

            // Original arrays should be unchanged
            expect(roots.map(r => r.entry.lastActivityAt)).toEqual(originalRootOrder);
            expect(roots[0].children.map(c => c.entry.conversationId)).toEqual(originalChildOrder);
        });
    });

    describe("renderTree", () => {
        it("should render root nodes with numbered list", () => {
            const roots = [
                {
                    entry: {
                        title: "Task A",
                        agentName: "pm",
                        startedAt: now - 360000,
                        lastActivityAt: now - 5000,
                        conversationId: "conv-a",
                    } as any,
                    children: [],
                },
                {
                    entry: {
                        title: "Task B",
                        agentName: "exec",
                        startedAt: now - 60000,
                        lastActivityAt: now - 1000,
                        conversationId: "conv-b",
                    } as any,
                    children: [],
                },
            ];

            const lines = renderTree(roots);
            expect(lines[0]).toMatch(/^1\. \*\*Task A\*\*/);
            // Line index depends on whether summary is present (it's not)
            const taskBLine = lines.find(l => l.includes("Task B"));
            expect(taskBLine).toMatch(/^2\. \*\*Task B\*\*/);
        });

        it("should render children with tree connectors ├─ and └─", () => {
            const roots = [
                {
                    entry: {
                        title: "Parent",
                        agentName: "pm",
                        startedAt: now - 360000,
                        lastActivityAt: now - 5000,
                        conversationId: "parent",
                    } as any,
                    children: [
                        {
                            entry: {
                                title: "Child 1",
                                agentName: "exec",
                                startedAt: now - 300000,
                                lastActivityAt: now - 3000,
                                conversationId: "child-1",
                            } as any,
                            children: [],
                        },
                        {
                            entry: {
                                title: "Child 2",
                                agentName: "dev",
                                startedAt: now - 8000,
                                lastActivityAt: now - 1000,
                                conversationId: "child-2",
                            } as any,
                            children: [],
                        },
                    ],
                },
            ];

            const lines = renderTree(roots);
            const child1Line = lines.find(l => l.includes("Child 1"));
            const child2Line = lines.find(l => l.includes("Child 2"));

            expect(child1Line).toContain("├─");
            expect(child2Line).toContain("└─");
        });

        it("should render single child with └─ connector", () => {
            const roots = [
                {
                    entry: {
                        title: "Parent",
                        agentName: "pm",
                        startedAt: now - 360000,
                        lastActivityAt: now - 5000,
                        conversationId: "parent",
                    } as any,
                    children: [
                        {
                            entry: {
                                title: "Only Child",
                                agentName: "exec",
                                startedAt: now - 120000,
                                lastActivityAt: now - 1000,
                                conversationId: "child",
                            } as any,
                            children: [],
                        },
                    ],
                },
            ];

            const lines = renderTree(roots);
            const childLine = lines.find(l => l.includes("Only Child"));
            expect(childLine).toContain("└─");
            expect(childLine).not.toContain("├─");
        });

        it("should include summary on a separate indented line", () => {
            const roots = [
                {
                    entry: {
                        title: "Task",
                        agentName: "pm",
                        startedAt: now - 360000,
                        lastActivityAt: now - 5000,
                        conversationId: "conv",
                        summary: "Working on feature X",
                    } as any,
                    children: [],
                },
            ];

            const lines = renderTree(roots);
            expect(lines.length).toBeGreaterThanOrEqual(2);
            expect(lines[1]).toContain("Working on feature X");
        });
    });

    describe("stale marking", () => {
        it("should mark conversations with no activity for >30 min as stale", () => {
            const entry = createMockRalEntry({
                conversationId: "stale-conv",
                lastActivityAt: now - 31 * 60 * 1000, // 31 minutes ago
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Stale Task",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("[stale]");
        });

        it("should not mark recent conversations as stale", () => {
            const entry = createMockRalEntry({
                conversationId: "fresh-conv",
                lastActivityAt: now - 5000, // 5 seconds ago
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Fresh Task",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).not.toContain("[stale]");
        });
    });

    describe("hierarchical delegation display (integration)", () => {
        it("should display parent-child delegation relationships", () => {
            const parentEntry = createMockRalEntry({
                conversationId: "conv-parent",
                agentPubkey: "pm-pubkey",
                lastActivityAt: now - 120000,
                createdAt: now - 360000,
            });
            const childEntry = createMockRalEntry({
                conversationId: "conv-child",
                agentPubkey: "exec-pubkey",
                lastActivityAt: now - 5000,
                createdAt: now - 8000,
            });

            getActiveEntriesForProjectSpy.mockReturnValue([parentEntry, childEntry]);
            conversationRegistryGetSpy.mockImplementation((convId: string) => {
                if (convId === "conv-parent") {
                    return createMockStore({
                        title: "Fix Bug",
                        delegationChain: [
                            { pubkey: "user-pk", displayName: "User", isUser: true, conversationId: "user-conv" },
                            { pubkey: "pm-pubkey", displayName: "pm", isUser: false, conversationId: "conv-parent" },
                        ],
                    });
                }
                return createMockStore({
                    title: "Execute Fix",
                    delegationChain: [
                        { pubkey: "user-pk", displayName: "User", isUser: true, conversationId: "user-conv" },
                        { pubkey: "pm-pubkey", displayName: "pm", isUser: false, conversationId: "conv-parent" },
                        { pubkey: "exec-pubkey", displayName: "exec", isUser: false, conversationId: "conv-child" },
                    ],
                });
            });

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Parent should be a root node
            expect(result).toMatch(/1\. \*\*Fix Bug\*\*/);
            // Child should be nested under parent with └─ connector
            expect(result).toContain("└─ **Execute Fix**");
        });

        it("should promote orphan when parent is not in active set", () => {
            const orphanEntry = createMockRalEntry({
                conversationId: "conv-orphan",
                agentPubkey: "exec-pubkey",
                lastActivityAt: now - 5000,
            });

            getActiveEntriesForProjectSpy.mockReturnValue([orphanEntry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Orphan Task",
                delegationChain: [
                    { pubkey: "user-pk", displayName: "User", isUser: true, conversationId: "user-conv" },
                    { pubkey: "pm-pubkey", displayName: "pm", isUser: false, conversationId: "missing-parent" },
                    { pubkey: "exec-pubkey", displayName: "exec", isUser: false, conversationId: "conv-orphan" },
                ],
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Should appear as a root node (promoted), not nested
            expect(result).toMatch(/1\. \*\*Orphan Task\*\*/);
            expect(result).not.toContain("├─");
            expect(result).not.toContain("└─");
        });
    });

    describe("ordering (most recent activity first)", () => {
        it("should order conversations by most recent activity first", () => {
            const older = createMockRalEntry({
                conversationId: "conv-old",
                lastActivityAt: now - 60000, // 1 minute ago
            });
            const newer = createMockRalEntry({
                conversationId: "conv-new",
                lastActivityAt: now - 5000, // 5 seconds ago
            });

            getActiveEntriesForProjectSpy.mockReturnValue([older, newer]);
            conversationRegistryGetSpy.mockImplementation((convId: string) => {
                if (convId === "conv-old") {
                    return createMockStore({ title: "Older Task" });
                }
                return createMockStore({ title: "Newer Task" });
            });

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Newer task should appear before older task
            const newerIndex = result.indexOf("Newer Task");
            const olderIndex = result.indexOf("Older Task");
            expect(newerIndex).toBeLessThan(olderIndex);
        });
    });

    describe("summary handling and sanitization", () => {
        it("should include summary when available", () => {
            const entry = createMockRalEntry();

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task",
                summary: "Working on feature implementation",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("Working on feature implementation");
        });

        it("should not include summary line when summary is not available", () => {
            const entry = createMockRalEntry();

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task",
                // No summary
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Output should just be the compact one-liner per conversation (no summary line)
            const lines = result.split("\n").filter(l => l.trim().length > 0);
            const taskLine = lines.find(l => l.includes("**Task**"));
            expect(taskLine).toBeDefined();
        });

        it("should sanitize summaries by removing newlines", () => {
            const entry = createMockRalEntry();

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task",
                summary: "Line 1\nLine 2\r\nLine 3",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("Line 1 Line 2 Line 3");
            expect(result).not.toContain("Line 1\nLine 2");
        });

        it("should truncate long summaries to max length including ellipsis", () => {
            const longSummary = "A".repeat(300);
            const entry = createMockRalEntry();

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task",
                summary: longSummary,
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Should be truncated with "..." and total length should be <= 200
            expect(result).toContain("A".repeat(197) + "...");
            expect(result).not.toContain("A".repeat(198) + "...");
        });
    });

    describe("deduplication of conversations", () => {
        it("should deduplicate multiple agents in the same conversation", () => {
            const entry1 = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "agent-1",
                isStreaming: true,
            });
            const entry2 = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "agent-2",
                isStreaming: false,
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry1, entry2]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Shared Task",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Should only show one entry for the conversation
            const taskMatches = result.match(/\*\*Shared Task\*\*/g);
            expect(taskMatches?.length).toBe(1);
        });
    });

    describe("max conversations limit", () => {
        it("should limit results to 10 conversations", () => {
            const manyEntries = Array.from({ length: 15 }, (_, i) =>
                createMockRalEntry({
                    conversationId: `conv-${i}`,
                    lastActivityAt: now - i * 1000,
                })
            );

            getActiveEntriesForProjectSpy.mockReturnValue(manyEntries);
            conversationRegistryGetSpy.mockImplementation((convId: string) =>
                createMockStore({ title: `Task ${convId}` })
            );

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Count numbered entries (root nodes)
            const numberedEntries = result.match(/^\d+\. \*\*/gm);
            // Should have at most 10 conversations total (some may be nested)
            expect(result).toContain("Task conv-0");
            expect(result).toContain("Task conv-9");
            expect(result).not.toContain("Task conv-10");
        });
    });

    describe("output format", () => {
        it("should include the section header", () => {
            const entry = createMockRalEntry();

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({ title: "Task" }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("## Active Conversations");
            expect(result).toContain("The following conversations are currently active");
        });

        it("should format entries with numbered list and bold title", () => {
            const entry = createMockRalEntry();

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({ title: "Active Task" }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toMatch(/1\. \*\*Active Task\*\*/);
        });

        it("should include duration since conversation started", () => {
            const entry = createMockRalEntry({
                createdAt: now - 90000, // 1m 30s ago
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({ title: "Task" }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("1m");
        });
    });

    describe("agent name resolution", () => {
        it("should use PubkeyService to resolve agent names", () => {
            const entry = createMockRalEntry({
                agentPubkey: "some-agent-pubkey",
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({ title: "Task" }));

            activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(mockPubkeyService.getNameSync).toHaveBeenCalledWith("some-agent-pubkey");
        });
    });

    describe("error handling", () => {
        it("should handle errors gracefully when getting conversation metadata", () => {
            const entry = createMockRalEntry();

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockImplementation(() => {
                throw new Error("Failed to load");
            });

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Should return empty string since all conversations failed
            expect(result).toBe("");
        });
    });
});
