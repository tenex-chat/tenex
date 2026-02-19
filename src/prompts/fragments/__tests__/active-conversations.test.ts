import { afterEach, beforeEach, describe, expect, it, spyOn, mock } from "bun:test";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { activeConversationsFragment } from "../08-active-conversations";
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

// Mock conversation store
const createMockStore = (overrides: Partial<{
    title: string;
    summary: string;
    messageCount: number;
}> = {}) => ({
    getMetadata: () => ({
        title: overrides.title,
        summary: overrides.summary,
    }),
    getAllMessages: () => Array(overrides.messageCount ?? 5).fill({}),
});

describe("activeConversationsFragment", () => {
    const now = Date.now();
    const projectId = "test-project";

    let getActiveEntriesForProjectSpy: ReturnType<typeof spyOn>;
    let conversationRegistryGetSpy: ReturnType<typeof spyOn>;
    let getPubkeyServiceSpy: ReturnType<typeof spyOn>;
    let mockPubkeyService: { getNameSync: ReturnType<typeof mock> };

    beforeEach(() => {
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
            expect(result).toContain("Active Task");
            expect(result).toContain("ID: conv-active-1");
            expect(result).toContain("Working on feature X");
            expect(result).toContain("Messages: 10");
            expect(result).toContain("streaming");
        });

        it("should include conversation ID for use with conversation_get", () => {
            const ralEntry = createMockRalEntry({
                conversationId: "test-conversation-id-12345",
                isStreaming: true,
            });

            getActiveEntriesForProjectSpy.mockReturnValue([ralEntry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task with ID",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("ID: test-conversation-id-12345");
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

    describe("status display", () => {
        it("should show 'streaming' for streaming agents", () => {
            const entry = createMockRalEntry({
                isStreaming: true,
                currentTool: undefined,
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({ title: "Task" }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("Status: streaming");
        });

        it("should show tool name for agents running tools", () => {
            const entry = createMockRalEntry({
                isStreaming: false,
                currentTool: "file_write",
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({ title: "Task" }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("Status: running file_write");
        });

        it("should show 'active' for non-streaming, no-tool agents", () => {
            const entry = createMockRalEntry({
                isStreaming: false,
                currentTool: undefined,
            });

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({ title: "Task" }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("Status: active");
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

            expect(result).toContain("Summary: Working on feature implementation");
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

            expect(result).not.toContain("Summary:");
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

        it("should prefer streaming agent when deduplicating", () => {
            const nonStreaming = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "non-streaming-agent",
                isStreaming: false,
            });
            const streaming = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "streaming-agent",
                isStreaming: true,
            });

            getActiveEntriesForProjectSpy.mockReturnValue([nonStreaming, streaming]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Should show streaming status (from the streaming agent)
            expect(result).toContain("Status: streaming");
        });

        it("should prefer agent running tool over idle agent when deduplicating", () => {
            // Order matters: idle agent comes first in the array
            const idle = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "idle-agent",
                isStreaming: false,
                currentTool: undefined,
            });
            const runningTool = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "tool-agent",
                isStreaming: false,
                currentTool: "file_read",
            });

            // Idle comes first - without the fix, entries[0] would be selected
            getActiveEntriesForProjectSpy.mockReturnValue([idle, runningTool]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Should show tool status (from the agent running a tool), not "active"
            expect(result).toContain("Status: running file_read");
            expect(result).not.toContain("Status: active");
        });

        it("should prefer agent with activeTools over idle agent when deduplicating", () => {
            const idle = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "idle-agent",
                isStreaming: false,
                currentTool: undefined,
                activeTools: new Map(),
            });
            const withActiveTools = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "active-tools-agent",
                isStreaming: false,
                currentTool: "shell_exec",
                activeTools: new Map([["tool-1", { toolCallId: "t1", startedAt: Date.now() }]]),
            });

            getActiveEntriesForProjectSpy.mockReturnValue([idle, withActiveTools]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Should show the agent with active tools
            expect(result).toContain("Status: running shell_exec");
        });

        it("should fall back to most recent activity when no agent is streaming or running tools", () => {
            const olderIdle = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "older-idle-agent",
                isStreaming: false,
                currentTool: undefined,
                lastActivityAt: now - 60000, // 1 minute ago
            });
            const newerIdle = createMockRalEntry({
                conversationId: "same-conv",
                agentPubkey: "newer-idle-agent",
                isStreaming: false,
                currentTool: undefined,
                lastActivityAt: now - 5000, // 5 seconds ago
            });

            // Older comes first in the array
            getActiveEntriesForProjectSpy.mockReturnValue([olderIdle, newerIdle]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task",
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Should use the agent with more recent activity
            expect(result).toContain("agent-newer-id");
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

            // Count how many "Agent:" entries appear (one per conversation)
            const agentMatches = result.match(/- Agent:/g);
            expect(agentMatches?.length).toBe(10);

            // Should include the most recent ones
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

            expect(result).toContain("Conversation abcdef12...");
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

            expect(result).toContain("Duration: 1m");
        });

        it("should include message count", () => {
            const entry = createMockRalEntry();

            getActiveEntriesForProjectSpy.mockReturnValue([entry]);
            conversationRegistryGetSpy.mockReturnValue(createMockStore({
                title: "Task",
                messageCount: 25,
            }));

            const result = activeConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            expect(result).toContain("Messages: 25");
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
