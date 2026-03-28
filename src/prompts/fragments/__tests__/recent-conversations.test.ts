import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { ConversationStore } from "@/conversations/ConversationStore";
import { recentConversationsFragment } from "../09-recent-conversations";

const createMockAgent = (pubkey = "agent-pubkey-123"): AgentInstance =>
    ({
        pubkey,
        slug: "test-agent",
    }) as AgentInstance;

describe("recentConversationsFragment", () => {
    const now = Math.floor(Date.now() / 1000);

    let getProjectIdSpy: ReturnType<typeof spyOn>;
    let getBasePathSpy: ReturnType<typeof spyOn>;
    let getInstanceSpy: ReturnType<typeof spyOn>;
    const mockQueryRecentForParticipant = mock(() => []);

    beforeEach(() => {
        mockQueryRecentForParticipant.mockReset().mockReturnValue([]);
        getProjectIdSpy = spyOn(ConversationStore, "getProjectId").mockReturnValue("current-project");
        getBasePathSpy = spyOn(ConversationStore, "getBasePath").mockReturnValue("/mock/projects");
        getInstanceSpy = spyOn(ConversationCatalogService, "getInstance").mockReturnValue({
            queryRecentForParticipant: mockQueryRecentForParticipant,
        } as unknown as ConversationCatalogService);
    });

    afterEach(() => {
        getProjectIdSpy.mockRestore();
        getBasePathSpy.mockRestore();
        getInstanceSpy.mockRestore();
    });

    it("queries the catalog with the expected participant, cutoff, exclusion, and limit", () => {
        recentConversationsFragment.template({
            agent: createMockAgent(),
            currentConversationId: "current-conversation",
        });

        expect(getInstanceSpy).toHaveBeenCalledWith("current-project", "/mock/projects/current-project");
        expect(mockQueryRecentForParticipant).toHaveBeenCalledTimes(1);
        expect(mockQueryRecentForParticipant).toHaveBeenCalledWith(
            expect.objectContaining({
                participantPubkey: "agent-pubkey-123",
                excludeConversationId: "current-conversation",
                limit: 10,
            })
        );
    });

    it("formats catalog results with sanitized summaries and placeholders", () => {
        mockQueryRecentForParticipant.mockReturnValue([
            {
                id: "conv-1",
                title: "Recent Task",
                summary: "Line 1\nLine 2",
                messageCount: 2,
                createdAt: now - 7200,
                lastActivity: now - 3600,
            },
            {
                id: "abcdef1234567890",
                title: undefined,
                summary: undefined,
                messageCount: 1,
                createdAt: now - 4000,
                lastActivity: now - 1800,
            },
        ]);

        const result = recentConversationsFragment.template({
            agent: createMockAgent(),
            currentConversationId: "other-conversation",
        });

        expect(result).toContain("## Recent Conversations (Past 24h)");
        expect(result).toContain("Recent Task");
        expect(result).toContain("Line 1 Line 2");
        expect(result).toContain("[No summary available]");
        expect(result).toContain("Conversation abcdef123456...");
    });

    it("returns an empty string when no project can be resolved", () => {
        getProjectIdSpy.mockReturnValue(null);

        const result = recentConversationsFragment.template({
            agent: createMockAgent(),
            currentConversationId: "other-conversation",
        });

        expect(result).toBe("");
        expect(getInstanceSpy).not.toHaveBeenCalled();
    });

    it("uses the provided projectId instead of the current project", () => {
        recentConversationsFragment.template({
            agent: createMockAgent(),
            currentConversationId: "other-conversation",
            projectId: "explicit-project",
        });

        expect(getInstanceSpy).toHaveBeenCalledWith("explicit-project", "/mock/projects/explicit-project");
    });
});
