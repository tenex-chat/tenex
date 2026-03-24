import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ConversationToolContext } from "@/tools/types";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// Mock SkillService
const mockFetchSkills = mock();
mock.module("@/services/skill/SkillService", () => ({
    SkillService: {
        getInstance: () => ({
            fetchSkills: mockFetchSkills,
        }),
    },
}));

import { createSkillsSetTool } from "../skills_set";

describe("skills_set tool", () => {
    const AGENT_PUBKEY = "a".repeat(64);
    const SKILL_ID_1 = "b".repeat(64);
    const SKILL_ID_2 = "c".repeat(64);

    const mockSetSelfAppliedSkills = mock();
    const mockGetSelfAppliedSkillIds = mock();

    const createMockContext = (): ConversationToolContext => ({
        agent: {
            name: "test-agent",
            slug: "test-agent",
            pubkey: AGENT_PUBKEY,
            eventId: "mock-event-id",
            llmConfig: { model: "gpt-4" },
        } as any,
        conversationId: "mock-conversation-id",
        conversationStore: {
            setSelfAppliedSkills: mockSetSelfAppliedSkills,
            getSelfAppliedSkillIds: mockGetSelfAppliedSkillIds,
        } as any,
        conversationCoordinator: {} as any,
        triggeringEnvelope: {
            id: "mock-triggering-event-id",
            tags: [],
        } as any,
        agentPublisher: {} as any,
        phase: "execution",
        ralNumber: 1,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => "mock-root-event-id",
        }) as any,
    } as ConversationToolContext);

    beforeEach(() => {
        mockFetchSkills.mockClear();
        mockSetSelfAppliedSkills.mockClear();
        mockGetSelfAppliedSkillIds.mockClear();
    });

    it("should clear all skills when empty array is passed", async () => {
        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute({ skills: [] }, { toolCallId: "tc1", messages: [], abortSignal: undefined as any });

        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith([], AGENT_PUBKEY);
        expect(result).toEqual({
            success: true,
            message: "All self-applied skills cleared.",
            activeSkills: [],
        });
        // Should NOT call SkillService when clearing
        expect(mockFetchSkills).not.toHaveBeenCalled();
    });

    it("should activate valid skills and store them", async () => {
        mockFetchSkills.mockResolvedValue({
            skills: [
                { name: "Brainstorming", shortId: "bcce7d32" },
                { name: "Wikifreedia Writer", shortId: "be3d0b26" },
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [SKILL_ID_1, SKILL_ID_2] },
            { toolCallId: "tc2", messages: [], abortSignal: undefined as any }
        );

        expect(mockFetchSkills).toHaveBeenCalledWith([SKILL_ID_1, SKILL_ID_2]);
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith([SKILL_ID_1, SKILL_ID_2], AGENT_PUBKEY);
        expect(result).toEqual({
            success: true,
            message: "Activated 2 skill(s): Brainstorming, Wikifreedia Writer. Skills will take effect on the next message cycle.",
            activeSkills: ["Brainstorming", "Wikifreedia Writer"],
        });
    });

    it("should return failure when no skills could be resolved", async () => {
        mockFetchSkills.mockResolvedValue({
            skills: [],
            content: "",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [SKILL_ID_1] },
            { toolCallId: "tc3", messages: [], abortSignal: undefined as any }
        );

        expect(mockFetchSkills).toHaveBeenCalledWith([SKILL_ID_1]);
        // Should NOT store skills if none resolved
        expect(mockSetSelfAppliedSkills).not.toHaveBeenCalled();
        expect(result).toEqual({
            success: false,
            message: `Could not resolve any skills from the provided identifiers: ${SKILL_ID_1}`,
            activeSkills: [],
        });
    });

    it("should use shortId as fallback name for unnamed skills", async () => {
        mockFetchSkills.mockResolvedValue({
            skills: [{ shortId: "abcd1234" }],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [SKILL_ID_1] },
            { toolCallId: "tc4", messages: [], abortSignal: undefined as any }
        );

        expect(result.activeSkills).toEqual(["abcd1234"]);
    });

    it("should fall back to 'unnamed' when skill has no name or shortId", async () => {
        mockFetchSkills.mockResolvedValue({
            skills: [{}],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [SKILL_ID_1] },
            { toolCallId: "tc5", messages: [], abortSignal: undefined as any }
        );

        expect(result.activeSkills).toEqual(["unnamed"]);
    });
});
