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
            skillContent: "",
        });
        // Should NOT call SkillService when clearing
        expect(mockFetchSkills).not.toHaveBeenCalled();
    });

    it("should activate valid skills and store them", async () => {
        mockFetchSkills.mockResolvedValue({
            skills: [
                { eventId: SKILL_ID_1, name: "Brainstorming", shortId: "bcce7d32", content: "content1", installedFiles: [] },
                { eventId: SKILL_ID_2, name: "Wikifreedia Writer", shortId: "be3d0b26", content: "content2", installedFiles: [] },
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
        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual(["Brainstorming", "Wikifreedia Writer"]);
        // Uses renderSkill for content, which produces <transient-skill> XML
        expect(result.skillContent).toContain("<transient-skill");
        expect(result.skillContent).toContain("content1");
        expect(result.skillContent).toContain("content2");
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
            skillContent: "",
        });
    });

    it("should use shortId as fallback name for unnamed skills", async () => {
        mockFetchSkills.mockResolvedValue({
            skills: [{ eventId: SKILL_ID_1, shortId: "abcd1234", content: "content", installedFiles: [] }],
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
            skills: [{ eventId: SKILL_ID_1, shortId: "", content: "", installedFiles: [] }],
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

    it("should reject partial resolution — some IDs valid, some not", async () => {
        const SKILL_ID_BAD = "d".repeat(64);
        // Only 1 of 2 skills resolves
        mockFetchSkills.mockResolvedValue({
            skills: [
                { eventId: SKILL_ID_1, name: "Brainstorming", shortId: "bcce7d32", content: "content", installedFiles: [] },
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [SKILL_ID_1, SKILL_ID_BAD] },
            { toolCallId: "tc6", messages: [], abortSignal: undefined as any }
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Partial resolution rejected");
        expect(result.message).toContain(SKILL_ID_BAD);
        // Must NOT persist anything on partial failure
        expect(mockSetSelfAppliedSkills).not.toHaveBeenCalled();
    });

    it("should persist canonical eventIds, not raw input strings", async () => {
        const CANONICAL_ID = "e".repeat(64);
        mockFetchSkills.mockResolvedValue({
            skills: [
                { eventId: CANONICAL_ID, name: "Test Skill", shortId: "eeeeeeeeeeee", content: "content", installedFiles: [] },
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        await toolDef.execute(
            { skills: [SKILL_ID_1] }, // raw input ID
            { toolCallId: "tc7", messages: [], abortSignal: undefined as any }
        );

        // Should persist the canonical eventId from SkillData, not the raw input
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith([CANONICAL_ID], AGENT_PUBKEY);
    });

    it("should return full rendered content with file paths for file-backed skills", async () => {
        mockFetchSkills.mockResolvedValue({
            skills: [
                {
                    eventId: SKILL_ID_1,
                    name: "Code Style",
                    title: "Code Style Guide",
                    shortId: "bbbbbbbbbbbb",
                    content: "Follow these patterns.",
                    installedFiles: [
                        {
                            eventId: "f".repeat(64),
                            relativePath: "style.md",
                            absolutePath: "/tmp/skills/bbbbbbbbbbbb/style.md",
                            success: true,
                        },
                        {
                            eventId: "1".repeat(64),
                            relativePath: "broken.md",
                            absolutePath: "/tmp/skills/bbbbbbbbbbbb/broken.md",
                            success: false,
                            error: "Download failed",
                        },
                    ],
                },
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [SKILL_ID_1] },
            { toolCallId: "tc8", messages: [], abortSignal: undefined as any }
        );

        expect(result.success).toBe(true);
        // Should use renderSkill output, not raw content string
        expect(result.skillContent).toContain("<transient-skill");
        expect(result.skillContent).toContain("Code Style Guide");
        expect(result.skillContent).toContain("Follow these patterns.");
        // Should include installed file paths
        expect(result.skillContent).toContain("/tmp/skills/bbbbbbbbbbbb/style.md");
        expect(result.skillContent).toContain("Installed Files");
        // Should include failed file info
        expect(result.skillContent).toContain("Failed File Downloads");
        expect(result.skillContent).toContain("Download failed");
        expect(result.skillContent).toContain("</transient-skill>");
        // Message should mention file paths
        expect(result.message).toContain("file paths");
    });

    it("should replace prior skills when called repeatedly in the same RAL", async () => {
        const SKILL_ID_3 = "f".repeat(64);

        // First call: activate skills 1 and 2
        mockFetchSkills.mockResolvedValueOnce({
            skills: [
                { eventId: SKILL_ID_1, name: "Brainstorming", shortId: "bcce7d32", content: "content1", installedFiles: [] },
                { eventId: SKILL_ID_2, name: "Wikifreedia Writer", shortId: "be3d0b26", content: "content2", installedFiles: [] },
            ],
            content: "skill content",
        });

        // Second call: activate only skill 3
        mockFetchSkills.mockResolvedValueOnce({
            skills: [
                { eventId: SKILL_ID_3, name: "Code Review", shortId: "ffffffff", content: "content3", installedFiles: [] },
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);

        // First invocation
        const result1 = await toolDef.execute(
            { skills: [SKILL_ID_1, SKILL_ID_2] },
            { toolCallId: "tc-repeat-1", messages: [], abortSignal: undefined as any }
        );
        expect(result1.success).toBe(true);
        expect(result1.activeSkills).toEqual(["Brainstorming", "Wikifreedia Writer"]);

        // Second invocation in same RAL — should fully replace, not append
        const result2 = await toolDef.execute(
            { skills: [SKILL_ID_3] },
            { toolCallId: "tc-repeat-2", messages: [], abortSignal: undefined as any }
        );
        expect(result2.success).toBe(true);
        expect(result2.activeSkills).toEqual(["Code Review"]);

        // The ConversationStore should have been called twice, each time with the full set for that call
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledTimes(2);
        expect(mockSetSelfAppliedSkills).toHaveBeenNthCalledWith(1, [SKILL_ID_1, SKILL_ID_2], AGENT_PUBKEY);
        // Second call overwrites — only skill 3, NOT [1, 2, 3]
        expect(mockSetSelfAppliedSkills).toHaveBeenNthCalledWith(2, [SKILL_ID_3], AGENT_PUBKEY);

        // Rendered content should only contain the latest skill
        expect(result2.skillContent).toContain("content3");
        expect(result2.skillContent).not.toContain("content1");
        expect(result2.skillContent).not.toContain("content2");
    });

    it("should activate valid skills and store canonical eventIds", async () => {
        mockFetchSkills.mockResolvedValue({
            skills: [
                { eventId: SKILL_ID_1, name: "Brainstorming", shortId: "bcce7d32", content: "content1", installedFiles: [] },
                { eventId: SKILL_ID_2, name: "Wikifreedia Writer", shortId: "be3d0b26", content: "content2", installedFiles: [] },
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [SKILL_ID_1, SKILL_ID_2] },
            { toolCallId: "tc9", messages: [], abortSignal: undefined as any }
        );

        expect(mockFetchSkills).toHaveBeenCalledWith([SKILL_ID_1, SKILL_ID_2]);
        // Persists canonical eventIds
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith([SKILL_ID_1, SKILL_ID_2], AGENT_PUBKEY);
        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual(["Brainstorming", "Wikifreedia Writer"]);
        // Uses renderSkill for content
        expect(result.skillContent).toContain("<transient-skill");
    });
});
