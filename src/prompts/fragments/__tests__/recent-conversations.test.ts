import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ConversationStore } from "@/conversations/ConversationStore";
import { recentConversationsFragment } from "../09-recent-conversations";
import type { AgentInstance } from "@/agents/types";

// Mock agent for testing
const createMockAgent = (pubkey: string = "agent-pubkey-123"): AgentInstance =>
    ({
        pubkey,
        slug: "test-agent",
    }) as AgentInstance;

describe("recentConversationsFragment", () => {
    const TWENTY_FOUR_HOURS_IN_SECONDS = 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);

    // Mock preview data (returned by readConversationPreview)
    const recentConversation1Preview = {
        id: "conv-1-recent",
        lastActivity: now - 3600, // 1 hour ago
        title: "Recent Task 1",
        summary: "Working on feature X",
        agentParticipated: true,
    };

    const recentConversation2Preview = {
        id: "conv-2-recent",
        lastActivity: now - 7200, // 2 hours ago
        title: "Recent Task 2",
        summary: undefined,
        agentParticipated: true,
    };

    const oldConversationPreview = {
        id: "conv-3-old",
        lastActivity: now - TWENTY_FOUR_HOURS_IN_SECONDS - 3600, // 25 hours ago
        title: "Old Task",
        summary: "Old summary",
        agentParticipated: true,
    };

    const currentConversationPreview = {
        id: "conv-current",
        lastActivity: now - 60, // 1 minute ago
        title: "Current Task",
        summary: "Current work",
        agentParticipated: true,
    };

    const noParticipationPreview = {
        id: "conv-no-participation",
        lastActivity: now - 1800, // 30 min ago
        title: "Other Agent Task",
        summary: "Other agent work",
        agentParticipated: false,
    };

    let listConversationIdsSpy: ReturnType<typeof spyOn>;
    let listConversationIdsForProjectSpy: ReturnType<typeof spyOn>;
    let readConversationPreviewSpy: ReturnType<typeof spyOn>;
    let readConversationPreviewForProjectSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // Reset spies - now we only mock the combined readConversationPreview
        listConversationIdsSpy = spyOn(ConversationStore, "listConversationIdsFromDisk");
        listConversationIdsForProjectSpy = spyOn(ConversationStore, "listConversationIdsFromDiskForProject");
        readConversationPreviewSpy = spyOn(ConversationStore, "readConversationPreview");
        readConversationPreviewForProjectSpy = spyOn(ConversationStore, "readConversationPreviewForProject");
    });

    afterEach(() => {
        // Clear all mocks
        listConversationIdsSpy.mockRestore();
        listConversationIdsForProjectSpy.mockRestore();
        readConversationPreviewSpy.mockRestore();
        readConversationPreviewForProjectSpy.mockRestore();
    });

    describe("24h cutoff logic", () => {
        it("should include conversations within the last 24 hours", () => {
            listConversationIdsSpy.mockReturnValue([recentConversation1Preview.id]);
            readConversationPreviewSpy.mockReturnValue(recentConversation1Preview);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).toContain("Recent Task 1");
            expect(result).toContain("1h ago");
        });

        it("should exclude conversations older than 24 hours", () => {
            listConversationIdsSpy.mockReturnValue([oldConversationPreview.id, recentConversation1Preview.id]);
            readConversationPreviewSpy.mockImplementation((id: string) => {
                if (id === oldConversationPreview.id) return oldConversationPreview;
                if (id === recentConversation1Preview.id) return recentConversation1Preview;
                return null;
            });

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).not.toContain("Old Task");
            expect(result).toContain("Recent Task 1");
        });
    });

    describe("exclusion of current conversation", () => {
        it("should exclude the current conversation from results", () => {
            listConversationIdsSpy.mockReturnValue([currentConversationPreview.id, recentConversation1Preview.id]);
            readConversationPreviewSpy.mockImplementation((id: string) => {
                if (id === currentConversationPreview.id) return currentConversationPreview;
                if (id === recentConversation1Preview.id) return recentConversation1Preview;
                return null;
            });

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: currentConversationPreview.id,
            });

            expect(result).not.toContain("Current Task");
            expect(result).toContain("Recent Task 1");
        });
    });

    describe("ordering (most recent first)", () => {
        it("should order conversations by most recent activity first", () => {
            const conv1Preview = { ...recentConversation1Preview, lastActivity: now - 7200 }; // 2h ago
            const conv2Preview = { ...recentConversation2Preview, id: "conv-newer", lastActivity: now - 1800, summary: "Newer summary" }; // 30m ago

            listConversationIdsSpy.mockReturnValue([conv1Preview.id, conv2Preview.id]);
            readConversationPreviewSpy.mockImplementation((id: string) => {
                if (id === conv1Preview.id) return conv1Preview;
                if (id === conv2Preview.id) return conv2Preview;
                return null;
            });

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            // conv2 (30m ago) should appear before conv1 (2h ago)
            const conv2Index = result.indexOf("Recent Task 2");
            const conv1Index = result.indexOf("Recent Task 1");
            expect(conv2Index).toBeLessThan(conv1Index);
        });
    });

    describe("summary handling and sanitization", () => {
        it("should use existing summary when available", () => {
            listConversationIdsSpy.mockReturnValue([recentConversation1Preview.id]);
            readConversationPreviewSpy.mockReturnValue(recentConversation1Preview);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).toContain("Working on feature X");
        });

        it("should use placeholder when summary is not available (prompt injection prevention)", () => {
            listConversationIdsSpy.mockReturnValue([recentConversation2Preview.id]);
            readConversationPreviewSpy.mockReturnValue(recentConversation2Preview);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            // Should NOT contain raw user text, should use placeholder
            expect(result).toContain("[No summary available]");
        });

        it("should sanitize summaries by removing newlines", () => {
            const convWithNewlines = {
                ...recentConversation1Preview,
                summary: "Line 1\nLine 2\r\nLine 3",
            };

            listConversationIdsSpy.mockReturnValue([convWithNewlines.id]);
            readConversationPreviewSpy.mockReturnValue(convWithNewlines);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).not.toContain("\n\n   Summary: Line 1\nLine 2");
            expect(result).toContain("Line 1 Line 2 Line 3");
        });

        it("should sanitize summaries by collapsing multiple spaces", () => {
            const convWithSpaces = {
                ...recentConversation1Preview,
                summary: "Text   with    multiple     spaces",
            };

            listConversationIdsSpy.mockReturnValue([convWithSpaces.id]);
            readConversationPreviewSpy.mockReturnValue(convWithSpaces);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).toContain("Text with multiple spaces");
        });

        it("should truncate long summaries to max length including ellipsis", () => {
            const longSummary = "A".repeat(300);
            const convWithLongSummary = {
                ...recentConversation1Preview,
                summary: longSummary,
            };

            listConversationIdsSpy.mockReturnValue([convWithLongSummary.id]);
            readConversationPreviewSpy.mockReturnValue(convWithLongSummary);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            // Should be truncated with "..." and total length should be <= 200
            // 197 chars + "..." = 200 chars
            expect(result).toContain("A".repeat(197) + "...");
            expect(result).not.toContain("A".repeat(198) + "...");
        });
    });

    describe("agent participation filtering", () => {
        it("should only include conversations where the agent participated", () => {
            listConversationIdsSpy.mockReturnValue([recentConversation1Preview.id, noParticipationPreview.id]);
            readConversationPreviewSpy.mockImplementation((id: string) => {
                if (id === recentConversation1Preview.id) return recentConversation1Preview;
                if (id === noParticipationPreview.id) return noParticipationPreview;
                return null;
            });

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).toContain("Recent Task 1");
            expect(result).not.toContain("Other Agent Task");
        });
    });

    describe("empty state", () => {
        it("should return empty string when no conversations exist", () => {
            listConversationIdsSpy.mockReturnValue([]);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "current",
            });

            expect(result).toBe("");
        });

        it("should return empty string when no recent conversations within 24h", () => {
            listConversationIdsSpy.mockReturnValue([oldConversationPreview.id]);
            readConversationPreviewSpy.mockReturnValue(oldConversationPreview);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "current",
            });

            expect(result).toBe("");
        });

        it("should return empty string when agent has not participated in any conversations", () => {
            listConversationIdsSpy.mockReturnValue([noParticipationPreview.id]);
            readConversationPreviewSpy.mockReturnValue(noParticipationPreview);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).toBe("");
        });
    });

    describe("max conversations limit", () => {
        it("should limit results to 10 conversations", () => {
            const manyConversations = Array.from({ length: 15 }, (_, i) => ({
                id: `conv-${i}`,
                lastActivity: now - i * 100, // Spread out over time
                title: `Task ${i}`,
                summary: `Summary ${i}`,
                agentParticipated: true,
            }));

            listConversationIdsSpy.mockReturnValue(manyConversations.map(c => c.id));
            readConversationPreviewSpy.mockImplementation((id: string) => {
                return manyConversations.find(c => c.id === id) || null;
            });

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            // Count how many "Summary:" entries appear
            const summaryMatches = result.match(/Summary:/g);
            expect(summaryMatches?.length).toBe(10);

            // Should include the most recent ones (Task 0 through Task 9)
            expect(result).toContain("Task 0");
            expect(result).toContain("Task 9");
            expect(result).not.toContain("Task 10");
        });
    });

    describe("output format", () => {
        it("should include the section header", () => {
            listConversationIdsSpy.mockReturnValue([recentConversation1Preview.id]);
            readConversationPreviewSpy.mockReturnValue(recentConversation1Preview);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).toContain("## Recent Conversations (Past 24h)");
            expect(result).toContain("You participated in the following conversations recently");
        });

        it("should format entries with numbered list, bold title, and relative time", () => {
            listConversationIdsSpy.mockReturnValue([recentConversation1Preview.id]);
            readConversationPreviewSpy.mockReturnValue(recentConversation1Preview);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).toMatch(/1\. \*\*Recent Task 1\*\* \(\d+[hm] ago\)/);
        });

        it("should use truncated conversation ID when title is missing", () => {
            const convNoTitle = {
                ...recentConversation1Preview,
                id: "abcdef1234567890",
                title: undefined,
            };

            listConversationIdsSpy.mockReturnValue([convNoTitle.id]);
            readConversationPreviewSpy.mockReturnValue(convNoTitle);

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            expect(result).toContain("Conversation abcdef12...");
        });
    });

    describe("I/O efficiency", () => {
        it("should call readConversationPreview only once per conversation", () => {
            const conversationIds = ["conv-1", "conv-2", "conv-3"];
            listConversationIdsSpy.mockReturnValue(conversationIds);
            readConversationPreviewSpy.mockImplementation((id: string) => ({
                id,
                lastActivity: now - 1000,
                title: `Task ${id}`,
                summary: `Summary ${id}`,
                agentParticipated: true,
            }));

            recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
            });

            // Should be called exactly once per conversation ID
            expect(readConversationPreviewSpy).toHaveBeenCalledTimes(3);
        });
    });

    describe("project scoping", () => {
        it("should use project-specific methods when projectId is provided", () => {
            const projectId = "test-project-123";
            const conversationIds = ["conv-1", "conv-2"];

            listConversationIdsForProjectSpy.mockReturnValue(conversationIds);
            readConversationPreviewForProjectSpy.mockImplementation((id: string, _agentPubkey: string, _projId: string) => ({
                id,
                lastActivity: now - 1000,
                title: `Task ${id}`,
                summary: `Summary ${id}`,
                agentParticipated: true,
            }));

            const result = recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                projectId,
            });

            // Verify project-specific methods were called
            expect(listConversationIdsForProjectSpy).toHaveBeenCalledWith(projectId);
            expect(listConversationIdsForProjectSpy).toHaveBeenCalledTimes(1);

            // Verify readConversationPreviewForProject was called with correct projectId
            expect(readConversationPreviewForProjectSpy).toHaveBeenCalledTimes(2);
            expect(readConversationPreviewForProjectSpy).toHaveBeenCalledWith("conv-1", "agent-pubkey-123", projectId);
            expect(readConversationPreviewForProjectSpy).toHaveBeenCalledWith("conv-2", "agent-pubkey-123", projectId);

            // Verify global methods were NOT called
            expect(listConversationIdsSpy).not.toHaveBeenCalled();
            expect(readConversationPreviewSpy).not.toHaveBeenCalled();

            // Verify output contains the expected conversations
            expect(result).toContain("Task conv-1");
            expect(result).toContain("Task conv-2");
        });

        it("should use global methods when projectId is not provided", () => {
            const conversationIds = ["conv-1"];

            listConversationIdsSpy.mockReturnValue(conversationIds);
            readConversationPreviewSpy.mockReturnValue({
                id: "conv-1",
                lastActivity: now - 1000,
                title: "Task conv-1",
                summary: "Summary conv-1",
                agentParticipated: true,
            });

            recentConversationsFragment.template({
                agent: createMockAgent(),
                currentConversationId: "other-conv",
                // No projectId provided
            });

            // Verify global methods were called
            expect(listConversationIdsSpy).toHaveBeenCalledTimes(1);
            expect(readConversationPreviewSpy).toHaveBeenCalledTimes(1);

            // Verify project-specific methods were NOT called
            expect(listConversationIdsForProjectSpy).not.toHaveBeenCalled();
            expect(readConversationPreviewForProjectSpy).not.toHaveBeenCalled();
        });
    });
});
