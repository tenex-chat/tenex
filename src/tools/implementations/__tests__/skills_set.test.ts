import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ConversationToolContext } from "@/tools/types";
import { agentStorage } from "@/agents/AgentStorage";
import * as projectServices from "@/services/projects";
import { SkillService } from "@/services/skill/SkillService";
import { createSkillsSetTool } from "../skills_set";

const mockFetchSkills = mock();
const mockListAvailableSkills = mock();
const mockUpdateDefaultConfig = mock();

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
    };

    const mockSetSelfAppliedSkills = mock();
    const mockGetSelfAppliedSkillIds = mock();
    let skillServiceSpy: ReturnType<typeof spyOn>;
    let updateDefaultConfigSpy: ReturnType<typeof spyOn>;
    let projectContextSpy: ReturnType<typeof spyOn>;

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
        skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            fetchSkills: mockFetchSkills,
            listAvailableSkills: mockListAvailableSkills,
        } as never);
        projectContextSpy = spyOn(projectServices, "getProjectContext").mockReturnValue({
            project: {
                dTag: PROJECT_DTAG,
                tagValue: mock(() => PROJECT_DTAG),
            },
        } as never);
        updateDefaultConfigSpy = spyOn(
            agentStorage,
            "updateDefaultConfig"
        ).mockImplementation(mockUpdateDefaultConfig as never);
        mockFetchSkills.mockClear();
        mockListAvailableSkills.mockClear();
        mockSetSelfAppliedSkills.mockClear();
        mockGetSelfAppliedSkillIds.mockClear();
        mockUpdateDefaultConfig.mockClear();
        mockListAvailableSkills.mockResolvedValue([]);
    });

    afterEach(() => {
        skillServiceSpy?.mockRestore();
        updateDefaultConfigSpy?.mockRestore();
        projectContextSpy?.mockRestore();
        mock.restore();
    });

    it("should clear all skills when empty array is passed", async () => {
        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [] },
            { toolCallId: "tc1", messages: [], abortSignal: undefined as any }
        );

        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith([], AGENT_PUBKEY);
        expect(result).toEqual({
            success: true,
            message: "All self-applied skills cleared.",
            activeSkills: [],
            skillContent: "",
        });
        expect(mockListAvailableSkills).not.toHaveBeenCalled();
        expect(mockFetchSkills).not.toHaveBeenCalled();
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
            { skills: ["brainstorming", "wikifreedia-writer"] },
            { toolCallId: "tc2", messages: [], abortSignal: undefined as any }
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
        expect(result.skillContent).toContain("<transient-skill");
        expect(result.skillContent).toContain("content1");
        expect(result.skillContent).toContain("content2");
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
            { skills: ["brainstorming"] },
            { toolCallId: "tc3", messages: [], abortSignal: undefined as any }
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
            { skills: ["brainstorming"] },
            { toolCallId: "tc5", messages: [], abortSignal: undefined as any }
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
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("brainstorming", SKILL_ID_1, {
                    name: "Brainstorming",
                    content: "content",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: ["brainstorming", "not-a-real-skill"] },
            { toolCallId: "tc6", messages: [], abortSignal: undefined as any }
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
            { skills: [SKILL_ID_1, "not-a-real-skill"] },
            { toolCallId: "tc6b", messages: [], abortSignal: undefined as any }
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("available skill list");
        expect(result.message).toContain(SKILL_ID_1);
        expect(result.message).toContain("not-a-real-skill");
        expect(mockFetchSkills).not.toHaveBeenCalled();
        expect(mockSetSelfAppliedSkills).not.toHaveBeenCalled();
    });

    it("should reject short skill ids before fetching", async () => {
        const skillShortId = SKILL_ID_1.slice(0, 12);
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("brainstorming")]);
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("brainstorming", SKILL_ID_1, {
                    name: "Brainstorming",
                    content: "content",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [skillShortId] },
            { toolCallId: "tc6c", messages: [], abortSignal: undefined as any }
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
            { skills: ["test-skill"] },
            { toolCallId: "tc7", messages: [], abortSignal: undefined as any }
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
            { skills: ["code-style"] },
            { toolCallId: "tc8", messages: [], abortSignal: undefined as any }
        );

        expect(result.success).toBe(true);
        expect(result.skillContent).toContain("<transient-skill");
        expect(result.skillContent).toContain('name="Code Style"');
        expect(result.skillContent).toContain("Follow these patterns.");
        expect(result.skillContent).toContain("/tmp/skills/code-style/style.md");
        expect(result.skillContent).toContain("Installed Files");
        expect(result.skillContent).toContain("Failed File Downloads");
        expect(result.skillContent).toContain("Download failed");
        expect(result.skillContent).toContain("</transient-skill>");
        expect(result.message).toContain("file paths");
    });

    it("should replace prior skills when called repeatedly in the same RAL", async () => {
        const skillId3 = "f".repeat(64);
        mockListAvailableSkills.mockResolvedValue([
            createAvailableSkill("brainstorming"),
            createAvailableSkill("wikifreedia-writer"),
            createAvailableSkill("code-review"),
        ]);
        mockFetchSkills.mockResolvedValueOnce({
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
        mockFetchSkills.mockResolvedValueOnce({
            skills: [
                createResolvedSkill("code-review", skillId3, {
                    name: "Code Review",
                    content: "content3",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);

        const result1 = await toolDef.execute(
            { skills: ["brainstorming", "wikifreedia-writer"] },
            { toolCallId: "tc-repeat-1", messages: [], abortSignal: undefined as any }
        );
        expect(result1.success).toBe(true);
        expect(result1.activeSkills).toEqual(["brainstorming", "wikifreedia-writer"]);

        const result2 = await toolDef.execute(
            { skills: ["code-review"] },
            { toolCallId: "tc-repeat-2", messages: [], abortSignal: undefined as any }
        );
        expect(result2.success).toBe(true);
        expect(result2.activeSkills).toEqual(["code-review"]);

        expect(mockSetSelfAppliedSkills).toHaveBeenCalledTimes(2);
        expect(mockSetSelfAppliedSkills).toHaveBeenNthCalledWith(
            1,
            ["brainstorming", "wikifreedia-writer"],
            AGENT_PUBKEY
        );
        expect(mockSetSelfAppliedSkills).toHaveBeenNthCalledWith(
            2,
            ["code-review"],
            AGENT_PUBKEY
        );
        expect(result2.skillContent).toContain("content3");
        expect(result2.skillContent).not.toContain("content1");
        expect(result2.skillContent).not.toContain("content2");
    });

    it("should activate valid skills and store local skill ids", async () => {
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
            { skills: ["brainstorming", "wikifreedia-writer"] },
            { toolCallId: "tc9", messages: [], abortSignal: undefined as any }
        );

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
        expect(result.skillContent).toContain("<transient-skill");
    });

    it("should persist to agent config when always: true", async () => {
        mockUpdateDefaultConfig.mockResolvedValue(true);
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("brainstorming")]);
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("brainstorming", SKILL_ID_1, {
                    name: "Brainstorming",
                    content: "content1",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: ["brainstorming"], always: true },
            { toolCallId: "tc-always-1", messages: [], abortSignal: undefined as any }
        );

        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith(["brainstorming"], AGENT_PUBKEY);
        expect(mockUpdateDefaultConfig).toHaveBeenCalledWith(AGENT_PUBKEY, {
            skills: ["brainstorming"],
        });
        expect(result.success).toBe(true);
        expect(result.message).toContain("Saved as always-on to agent config");
        expect(result.message).not.toContain("file paths");
    });

    it("should NOT call updateDefaultConfig when always is not set", async () => {
        mockListAvailableSkills.mockResolvedValue([createAvailableSkill("brainstorming")]);
        mockFetchSkills.mockResolvedValue({
            skills: [
                createResolvedSkill("brainstorming", SKILL_ID_1, {
                    name: "Brainstorming",
                    content: "content1",
                }),
            ],
            content: "skill content",
        });

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        await toolDef.execute(
            { skills: ["brainstorming"] },
            { toolCallId: "tc-always-2", messages: [], abortSignal: undefined as any }
        );

        expect(mockUpdateDefaultConfig).not.toHaveBeenCalled();
    });

    it("should persist empty skills to agent config when clearing with always: true", async () => {
        mockUpdateDefaultConfig.mockResolvedValue(true);

        const context = createMockContext();
        const toolDef = createSkillsSetTool(context);
        const result = await toolDef.execute(
            { skills: [], always: true },
            { toolCallId: "tc-always-3", messages: [], abortSignal: undefined as any }
        );

        expect(mockSetSelfAppliedSkills).toHaveBeenCalledWith([], AGENT_PUBKEY);
        expect(mockUpdateDefaultConfig).toHaveBeenCalledWith(AGENT_PUBKEY, { skills: [] });
        expect(result.success).toBe(true);
        expect(result.message).toBe("All self-applied skills cleared.");
    });
});
