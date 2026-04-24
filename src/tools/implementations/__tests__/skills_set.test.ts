import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ConversationToolContext } from "@/tools/types";
import { SkillService } from "@/services/skill/SkillService";
import { SkillWhitelistService } from "@/services/skill";
import { createSkillsSetTool } from "../skills_set";

const mockFetchSkills = mock();
const mockListAvailableSkills = mock();

function createAvailableSkill(identifier: string) {
    return {
        identifier,
        content: "",
        installedFiles: [],
    };
}

function createResolvedSkill(
    identifier: string,
    eventId: string,
    overrides: Record<string, unknown> = {}
) {
    return {
        identifier,
        eventId,
        name: identifier,
        content: `${identifier} content`,
        installedFiles: [],
        ...overrides,
    };
}

describe("skills_set tool", () => {
    const AGENT_PUBKEY = "a".repeat(64);
    const PROJECT_DTAG = "TENEX-ff3ssq";
    const SKILL_ID_1 = "b".repeat(64);
    const SKILL_ID_2 = "c".repeat(64);
    const SKILL_LOOKUP_CONTEXT = {
        agentPubkey: AGENT_PUBKEY,
        projectDTag: PROJECT_DTAG,
        projectPath: "/tmp/test",
    };

    const mockSetSelfAppliedSkills = mock();
    const mockGetSelfAppliedSkillIds = mock();
    let whitelistServiceSpy: ReturnType<typeof spyOn>;
    let skillServiceSpy: ReturnType<typeof spyOn>;

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
        projectContext: {
            project: {
                dTag: PROJECT_DTAG,
                tagValue: mock(() => PROJECT_DTAG),
            },
        } as any,
        getConversation: () => ({
            getRootEventId: () => "mock-root-event-id",
        }) as any,
    } as ConversationToolContext);

    const toolCallOpts = (id: string) => ({
        toolCallId: id,
        messages: [],
        abortSignal: undefined as any,
    });

    beforeEach(() => {
        SkillWhitelistService.getInstance().setInstalledSkills([]);
        skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            fetchSkills: mockFetchSkills,
            listAvailableSkills: mockListAvailableSkills,
        } as never);
        whitelistServiceSpy = spyOn(SkillWhitelistService.getInstance(), "getWhitelistedSkills").mockReturnValue([]);
        mockFetchSkills.mockClear();
        mockListAvailableSkills.mockClear();
        mockSetSelfAppliedSkills.mockClear();
        mockGetSelfAppliedSkillIds.mockClear();
        mockListAvailableSkills.mockResolvedValue([]);
        mockGetSelfAppliedSkillIds.mockReturnValue([]);
    });

    afterEach(() => {
        skillServiceSpy?.mockRestore();
        whitelistServiceSpy?.mockRestore();
        mock.restore();
    });

    it("should return current active set when both add and remove are omitted (no-op)", async () => {
        mockGetSelfAppliedSkillIds.mockReturnValue(["brainstorming"]);

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute({}, toolCallOpts("tc-noop-1"));

        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual(["brainstorming"]);
        expect(result.message).toContain("brainstorming");
        expect(mockSetSelfAppliedSkills).not.toHaveBeenCalled();
        expect(mockListAvailableSkills).not.toHaveBeenCalled();
    });

    it("should return no-op message when no skills active and both fields omitted", async () => {
        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute({}, toolCallOpts("tc-noop-2"));

        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual([]);
        expect(result.message).toContain("No skills currently active");
    });

    it("should add skills incrementally, preserving existing ones", async () => {
        mockGetSelfAppliedSkillIds.mockReturnValue(["brainstorming"]);
        mockListAvailableSkills.mockResolvedValue([
            createAvailableSkill("brainstorming"),
            createAvailableSkill("wikifreedia-writer"),
        ]);
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("wikifreedia-writer", SKILL_ID_2, {
                    name: "Wikifreedia Writer",
                    content: "content2",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: ["wikifreedia-writer"] },
            toolCallOpts("tc-add-incr")
        );

        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual(
            expect.arrayContaining(["brainstorming", "wikifreedia-writer"])
        );
        expect(result.activeSkills).toHaveLength(2);
        // Only newly-added skill content returned
        expect(result.skillContent).toContain("content2");
        expect(result.skillContent).not.toContain("content1");
        // fetchSkills called only for the new skill
        expect(mockFetchSkills).toHaveBeenCalledWith(["wikifreedia-writer"], SKILL_LOOKUP_CONTEXT);
    });

    it("should remove specific skills", async () => {
        mockGetSelfAppliedSkillIds.mockReturnValue(["brainstorming", "wikifreedia-writer"]);

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { remove: ["brainstorming"] },
            toolCallOpts("tc-remove-1")
        );

        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual(["wikifreedia-writer"]);
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith(["wikifreedia-writer"], AGENT_PUBKEY);
        expect(mockFetchSkills).not.toHaveBeenCalled();
    });

    it("should clear all skills with remove: ['*']", async () => {
        mockGetSelfAppliedSkillIds.mockReturnValue(["brainstorming", "wikifreedia-writer"]);

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { remove: ["*"] },
            toolCallOpts("tc-wildcard")
        );

        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual([]);
        expect(result.message).toBe("All self-applied skills cleared.");
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith([], AGENT_PUBKEY);
    });

    it("should fail when same ID appears in both add and remove", async () => {
        mockGetSelfAppliedSkillIds.mockReturnValue(["brainstorming"]);

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: ["brainstorming"], remove: ["brainstorming"] },
            toolCallOpts("tc-conflict")
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Conflicting intent");
        expect(result.message).toContain("brainstorming");
        expect(mockSetSelfAppliedSkills).not.toHaveBeenCalled();
        expect(mockFetchSkills).not.toHaveBeenCalled();
    });

    it("should silently ignore remove IDs that aren't currently active", async () => {
        mockGetSelfAppliedSkillIds.mockReturnValue(["brainstorming"]);

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { remove: ["not-active-skill"] },
            toolCallOpts("tc-remove-noop")
        );

        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual(["brainstorming"]);
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith(["brainstorming"], AGENT_PUBKEY);
    });

    it("should activate valid skills and store them", async () => {
        mockListAvailableSkills.mockResolvedValue([
            createAvailableSkill("brainstorming"),
            createAvailableSkill("wikifreedia-writer"),
        ]);
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("brainstorming", SKILL_ID_1, {
                    name: "Brainstorming",
                    content: "content1",
                }),
                createResolvedSkill("wikifreedia-writer", SKILL_ID_2, {
                    name: "Wikifreedia Writer",
                    content: "content2",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: ["brainstorming", "wikifreedia-writer"] },
            toolCallOpts("tc2")
        );

        expect(mockListAvailableSkills).toHaveBeenCalledWith(SKILL_LOOKUP_CONTEXT);
        expect(mockFetchSkills).toHaveBeenCalledWith(
            ["brainstorming", "wikifreedia-writer"],
            SKILL_LOOKUP_CONTEXT
        );
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith(
            ["brainstorming", "wikifreedia-writer"],
            AGENT_PUBKEY
        );
        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual(["brainstorming", "wikifreedia-writer"]);
        expect(result.skillContent).toContain("<skill");
        expect(result.skillContent).toContain("content1");
        expect(result.skillContent).toContain("content2");
    });

    it("should reject blocked skills before availability validation", async () => {
        whitelistServiceSpy.mockReturnValue([
            {
                eventId: SKILL_ID_1,
                identifier: "shell",
                kind: 4202 as never,
                name: "Shell",
                description: "Shell skill",
                whitelistedBy: ["pubkey"],
            },
        ] as never);
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("shell")]);

        const context = createMockContext();
        (context.agent as any).blockedSkills = ["shell"];
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: ["shell"] },
            toolCallOpts("tc-blocked")
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Cannot activate blocked skill(s): shell");
        expect(mockFetchSkills).not.toHaveBeenCalled();
        expect(mockSetSelfAppliedSkills).not.toHaveBeenCalled();
    });

    it("should reject an add resolved through an event id alias", async () => {
        whitelistServiceSpy.mockReturnValue([
            {
                eventId: SKILL_ID_1,
                kind: 4202 as never,
                name: "Shell",
                description: "Shell skill",
                whitelistedBy: ["pubkey"],
            },
        ] as never);
        mockListAvailableSkills.mockResolvedValue([createResolvedSkill("shell", SKILL_ID_1)]);

        const context = createMockContext();
        (context.agent as any).blockedSkills = ["shell"];
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: [SKILL_ID_1] },
            toolCallOpts("tc-blocked-alias")
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain(`Cannot activate blocked skill(s): ${SKILL_ID_1}`);
    });

    it("should treat removing a blocked skill as a no-op", async () => {
        const context = createMockContext();
        (context.agent as any).blockedSkills = ["shell"];
        mockGetSelfAppliedSkillIds.mockReturnValue(["brainstorming"]);

        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { remove: ["shell"] },
            toolCallOpts("tc-remove-blocked")
        );

        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual(["brainstorming"]);
        expect(mockFetchSkills).not.toHaveBeenCalled();
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith(["brainstorming"], AGENT_PUBKEY);
    });

    it("should return failure when no skills could be resolved", async () => {
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("brainstorming")]);
        mockFetchSkills.mockResolvedValue({
            skills: [],
            content: "",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: ["brainstorming"] },
            toolCallOpts("tc3")
        );

        expect(mockFetchSkills).toHaveBeenCalledWith(["brainstorming"], SKILL_LOOKUP_CONTEXT);
        expect(mockSetSelfAppliedSkills).not.toHaveBeenCalled();
        expect(result).toEqual({
            success: false,
            message: "Could not resolve any skills from the provided identifiers: brainstorming",
            activeSkills: [],
            skillContent: "",
        });
    });

    it("should fail if a loaded skill does not have a local identifier", async () => {
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("brainstorming")]);
        mockFetchSkills.mockResolvedValue({
            skills: [{ eventId: SKILL_ID_1, content: "", installedFiles: [] }],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: ["brainstorming"] },
            toolCallOpts("tc5")
        );

        expect(result).toEqual({
            success: false,
            message: "One or more loaded skills did not have a local identifier. No changes were made.",
            activeSkills: [],
            skillContent: "",
        });
    });

    it("should reject partial resolution — some IDs valid, some not", async () => {
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("brainstorming")]);

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: ["brainstorming", "not-a-real-skill"] },
            toolCallOpts("tc6")
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Partial resolution rejected");
        expect(result.message).toContain("not-a-real-skill");
        expect(mockSetSelfAppliedSkills).not.toHaveBeenCalled();
        expect(mockFetchSkills).not.toHaveBeenCalled();
    });

    it("should reject non-local skill ids before fetch", async () => {
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("brainstorming")]);

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: [SKILL_ID_1, "not-a-real-skill"] },
            toolCallOpts("tc6b")
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("available from `skill_list`");
        expect(result.message).toContain(SKILL_ID_1);
        expect(result.message).toContain("not-a-real-skill");
        expect(mockFetchSkills).not.toHaveBeenCalled();
        expect(mockSetSelfAppliedSkills).not.toHaveBeenCalled();
    });

    it("should reject short skill ids before fetching", async () => {
        const skillShortId = SKILL_ID_1.slice(0, 12);
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("brainstorming")]);

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: [skillShortId] },
            toolCallOpts("tc6c")
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain(skillShortId);
        expect(mockFetchSkills).not.toHaveBeenCalled();
    });

    it("should persist exact local skill ids", async () => {
        const canonicalId = "e".repeat(64);
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("test-skill")]);
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("test-skill", canonicalId, {
                    name: "Test Skill",
                    content: "content",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        await toolDef.execute(
            { add: ["test-skill"] },
            toolCallOpts("tc7")
        );

        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith(["test-skill"], AGENT_PUBKEY);
    });

    it("should return full rendered content with file paths for file-backed skills", async () => {
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("code-style")]);
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("code-style", SKILL_ID_1, {
                    name: "Code Style",
                    content: "Follow these patterns.",
                    installedFiles: [
                        {
                            eventId: "f".repeat(64),
                            relativePath: "style.md",
                            absolutePath: "/tmp/skills/code-style/style.md",
                            success: true,
                        },
                        {
                            eventId: "1".repeat(64),
                            relativePath: "broken.md",
                            absolutePath: "/tmp/skills/code-style/broken.md",
                            success: false,
                            error: "Download failed",
                        },
                    ],
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: ["code-style"] },
            toolCallOpts("tc8")
        );

        expect(result.success).toBe(true);
        expect(result.skillContent).toContain("<skill");
        expect(result.skillContent).toContain("Follow these patterns.");
        expect(result.skillContent).toContain("Failed File Downloads");
        expect(result.skillContent).toContain("Download failed");
        expect(result.skillContent).toContain("</skill>");
        expect(result.message).toContain("file paths");
    });

    it("should not re-fetch skills that are already active when adding", async () => {
        mockGetSelfAppliedSkillIds.mockReturnValue(["brainstorming"]);
        mockListAvailableSkills.mockResolvedValue([
            createAvailableSkill("brainstorming"),
            createAvailableSkill("wikifreedia-writer"),
        ]);
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("wikifreedia-writer", SKILL_ID_2, {
                    name: "Wikifreedia Writer",
                    content: "content2",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { add: ["brainstorming", "wikifreedia-writer"] },
            toolCallOpts("tc-no-refetch")
        );

        expect(result.success).toBe(true);
        // Should only fetch the newly-added skill
        expect(mockFetchSkills).toHaveBeenCalledWith(["wikifreedia-writer"], SKILL_LOOKUP_CONTEXT);
        expect(result.activeSkills).toEqual(
            expect.arrayContaining(["brainstorming", "wikifreedia-writer"])
        );
    });

    it("should handle remove: ['*'] combined with add", async () => {
        mockGetSelfAppliedSkillIds.mockReturnValue(["brainstorming", "old-skill"]);
        mockListAvailableSkills.mockResolvedValue([
            createAvailableSkill("wikifreedia-writer"),
        ]);
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("wikifreedia-writer", SKILL_ID_2, {
                    name: "Wikifreedia Writer",
                    content: "content2",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { remove: ["*"], add: ["wikifreedia-writer"] },
            toolCallOpts("tc-wildcard-add")
        );

        expect(result.success).toBe(true);
        expect(result.activeSkills).toEqual(["wikifreedia-writer"]);
        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith(["wikifreedia-writer"], AGENT_PUBKEY);
    });
});
