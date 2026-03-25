import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as nudgeModule from "@/services/nudge";
import type { WhitelistItem } from "@/services/nudge";
import { NDKKind } from "@/nostr/kinds";
import { SkillService } from "@/services/skill/SkillService";

const mockGetWhitelistedNudges = mock(() => [] as WhitelistItem[]);
const mockGetWhitelistedSkills = mock(() => [] as WhitelistItem[]);
const mockListAvailableSkills = mock(() => Promise.resolve([]));
const mockService = {
    getWhitelistedNudges: mockGetWhitelistedNudges,
    getWhitelistedSkills: mockGetWhitelistedSkills,
};
let getInstanceSpy: ReturnType<typeof spyOn>;
let listAvailableSkillsSpy: ReturnType<typeof spyOn>;
const AGENT_PUBKEY = "a".repeat(64);
const PROJECT_DTAG = "TENEX-ff3ssq";

const { availableNudgesAndSkillsFragment } = await import("../13-available-nudges");

function createMockNudge(overrides: Partial<WhitelistItem> = {}): WhitelistItem {
    return {
        eventId: "abc123def456789012345678901234567890123456789012345678901234",
        kind: NDKKind.AgentNudge,
        identifier: "be-brief",
        shortId: "abc123def456",
        name: "Test Nudge",
        description: "Test description",
        whitelistedBy: ["pubkey1"],
        ...overrides,
    };
}

function createMockSkill(overrides: Record<string, unknown> = {}) {
    return {
        identifier: "poster-kit",
        content: "Test skill description",
        installedFiles: [],
        ...overrides,
    };
}

async function render(
    nudges: WhitelistItem[] = [],
    skills: Array<Record<string, unknown>> = []
): Promise<string> {
    mockGetWhitelistedNudges.mockImplementation(() => nudges);
    mockListAvailableSkills.mockResolvedValue(skills);
    return await availableNudgesAndSkillsFragment.template({
        agentPubkey: AGENT_PUBKEY,
        projectDTag: PROJECT_DTAG,
    });
}

beforeEach(() => {
    getInstanceSpy = spyOn(
        nudgeModule.NudgeSkillWhitelistService,
        "getInstance"
    ).mockReturnValue(mockService as never);
    listAvailableSkillsSpy = spyOn(
        SkillService,
        "getInstance"
    ).mockReturnValue({
        listAvailableSkills: mockListAvailableSkills,
    } as never);
    mockGetWhitelistedNudges.mockImplementation(() => []);
    mockGetWhitelistedSkills.mockImplementation(() => []);
    mockListAvailableSkills.mockResolvedValue([]);
});

afterEach(() => {
    getInstanceSpy?.mockRestore();
    listAvailableSkillsSpy?.mockRestore();
    mock.restore();
});

describe("availableNudgesAndSkillsFragment", () => {
    it("returns empty string when no nudges or skills are available", async () => {
        expect(await render()).toBe("");
    });

    it("renders nudge identifiers exactly as shown", async () => {
        const result = await render([createMockNudge()]);
        expect(result).toContain("## Available Nudges and Skills");
        expect(result).toContain("`be-brief`");
        expect(result).toContain("Test description");
        expect(result).not.toContain("(abc123def456)");
    });

    it("renders local skill directory ids, not remote event ids", async () => {
        const result = await render([], [createMockSkill({ identifier: "make-poster" })]);
        expect(result).toContain("`make-poster`");
        expect(result).toContain("Test skill description");
        expect(result).not.toContain("skill123def4)");
        expect(mockListAvailableSkills).toHaveBeenCalledWith({
            agentPubkey: AGENT_PUBKEY,
            projectDTag: PROJECT_DTAG,
        });
    });

    it("prefers frontmatter descriptions over SKILL.md body content for skills", async () => {
        const result = await render([], [
            createMockSkill({
                description: "Frontmatter-backed summary",
                content: "Long skill body that should not be used in the listing",
            }),
        ]);

        expect(result).toContain("Frontmatter-backed summary");
        expect(result).not.toContain("Long skill body that should not be used in the listing");
    });

    it("shows both sections when both nudges and skills exist", async () => {
        const result = await render([createMockNudge()], [createMockSkill()]);
        expect(result).toContain("### Nudges");
        expect(result).toContain("### Skills");
    });

    it("does not include usage examples", async () => {
        const result = await render([createMockNudge()], [createMockSkill()]);
        expect(result).not.toContain("Nudge example:");
        expect(result).not.toContain("Skill example:");
        expect(result).not.toContain("delegate({");
        expect(result).not.toContain("skills_set({");
    });

    it("does not include scope or directory explanations", async () => {
        const result = await render([], [createMockSkill()]);
        expect(result).not.toContain("agent > project > global > ~/.agents");
        expect(result).not.toContain("$TENEX_BASE_DIR/home/<agent-short-pubkey>/skills/<id>/SKILL.md");
        expect(result).not.toContain("$TENEX_BASE_DIR/projects/<project-dTag>/skills/<id>/SKILL.md");
        expect(result).not.toContain("$TENEX_BASE_DIR/skills/<id>/SKILL.md");
        expect(result).not.toContain("~/.agents/skills/<id>/SKILL.md");
    });
});
