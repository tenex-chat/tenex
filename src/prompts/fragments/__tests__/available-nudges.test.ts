import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as nudgeModule from "@/services/nudge";
import type { WhitelistItem } from "@/services/nudge";
import { NDKKind } from "@/nostr/kinds";

const mockGetWhitelistedNudges = mock(() => [] as WhitelistItem[]);
const mockGetWhitelistedSkills = mock(() => [] as WhitelistItem[]);
const mockService = {
    getWhitelistedNudges: mockGetWhitelistedNudges,
    getWhitelistedSkills: mockGetWhitelistedSkills,
};
let getInstanceSpy: ReturnType<typeof spyOn>;

const { availableNudgesAndSkillsFragment } = await import("../13-available-nudges");

function createMockNudge(overrides: Partial<WhitelistItem> = {}): WhitelistItem {
    return {
        eventId: "abc123def456789012345678901234567890123456789012345678901234",
        kind: NDKKind.AgentNudge,
        name: "Test Nudge",
        description: "Test description",
        whitelistedBy: ["pubkey1"],
        ...overrides,
    };
}

function createMockSkill(overrides: Partial<WhitelistItem> = {}): WhitelistItem {
    return {
        eventId: "skill123def456789012345678901234567890123456789012345678901234",
        kind: NDKKind.AgentSkill,
        name: "Test Skill",
        description: "Test skill description",
        whitelistedBy: ["pubkey1"],
        ...overrides,
    };
}

function render(nudges: WhitelistItem[] = [], skills: WhitelistItem[] = []): string {
    mockGetWhitelistedNudges.mockImplementation(() => nudges);
    mockGetWhitelistedSkills.mockImplementation(() => skills);
    return availableNudgesAndSkillsFragment.template({} as Record<string, never>);
}

beforeEach(() => {
    getInstanceSpy = spyOn(
        nudgeModule.NudgeSkillWhitelistService,
        "getInstance"
    ).mockReturnValue(mockService as never);
    mockGetWhitelistedNudges.mockImplementation(() => []);
    mockGetWhitelistedSkills.mockImplementation(() => []);
});

afterEach(() => {
    getInstanceSpy?.mockRestore();
    mock.restore();
});

describe("availableNudgesAndSkillsFragment (combined nudges + skills)", () => {
    describe("empty state", () => {
        it("should return empty string when both are empty", () => {
            expect(render()).toBe("");
        });
    });

    describe("heading", () => {
        it("should use 'Available Nudges and Skills' heading with nudges only", () => {
            expect(render([createMockNudge()])).toContain("## Available Nudges and Skills");
        });

        it("should use 'Available Nudges and Skills' heading with skills only", () => {
            expect(render([], [createMockSkill()])).toContain("## Available Nudges and Skills");
        });

        it("should use 'Available Nudges and Skills' heading with both", () => {
            expect(render([createMockNudge()], [createMockSkill()])).toContain("## Available Nudges and Skills");
        });
    });

    describe("subsection headers", () => {
        it("should NOT show subsection headers when only nudges exist", () => {
            const result = render([createMockNudge()]);
            expect(result).not.toContain("### Nudges");
            expect(result).not.toContain("### Skills");
            expect(result).toContain("**Test Nudge**");
        });

        it("should NOT show subsection headers when only skills exist", () => {
            const result = render([], [createMockSkill()]);
            expect(result).not.toContain("### Nudges");
            expect(result).not.toContain("### Skills");
            expect(result).toContain("**Test Skill**");
        });

        it("should show BOTH subsection headers when both nudges and skills exist", () => {
            const result = render([createMockNudge()], [createMockSkill()]);
            expect(result).toContain("### Nudges");
            expect(result).toContain("### Skills");
        });
    });

    describe("nudge-only rendering", () => {
        it("should render a single nudge correctly", () => {
            const result = render([createMockNudge()]);
            expect(result).toContain("**Test Nudge**");
            expect(result).toContain("Test description");
            expect(result).toContain("(abc123def456)");
        });

        it("should render multiple nudges", () => {
            const result = render([
                createMockNudge({ eventId: "event1", name: "First Nudge" }),
                createMockNudge({ eventId: "event2", name: "Second Nudge" }),
            ]);
            expect(result).toContain("**First Nudge**");
            expect(result).toContain("**Second Nudge**");
        });

        it("should use truncated event ID when name is missing", () => {
            expect(render([createMockNudge({ name: undefined })])).toContain("**abc123def456**");
        });

        it("should show 'No description' when description is missing", () => {
            expect(render([createMockNudge({ description: undefined })])).toContain("No description");
        });
    });

    describe("skill-only rendering", () => {
        it("should render a single skill correctly", () => {
            const result = render([], [createMockSkill()]);
            expect(result).toContain("**Test Skill**");
            expect(result).toContain("Test skill description");
            expect(result).toContain("(skill123def4)");
        });

        it("should render multiple skills", () => {
            const result = render([], [
                createMockSkill({ eventId: "event1", name: "First Skill" }),
                createMockSkill({ eventId: "event2", name: "Second Skill" }),
            ]);
            expect(result).toContain("**First Skill**");
            expect(result).toContain("**Second Skill**");
        });
    });

    describe("combined rendering", () => {
        it("should render both nudges and skills with subsection headers", () => {
            const result = render([createMockNudge()], [createMockSkill()]);
            expect(result).toContain("## Available Nudges and Skills");
            expect(result).toContain("### Nudges");
            expect(result).toContain("**Test Nudge**");
            expect(result).toContain("### Skills");
            expect(result).toContain("**Test Skill**");
        });

        it("should place nudges before skills", () => {
            const result = render([createMockNudge()], [createMockSkill()]);
            expect(result.indexOf("### Nudges")).toBeLessThan(result.indexOf("### Skills"));
        });
    });

    describe("description truncation", () => {
        it("should truncate descriptions longer than 150 characters", () => {
            const result = render([createMockNudge({ description: "A".repeat(200) })]);
            expect(result).toContain("A".repeat(150));
            expect(result).not.toContain("A".repeat(151));
        });

        it("should not truncate descriptions shorter than 150 characters", () => {
            const shortDescription = "B".repeat(100);
            expect(render([createMockNudge({ description: shortDescription })])).toContain(shortDescription);
        });

        it("should replace newlines with spaces in descriptions", () => {
            const result = render([createMockNudge({ description: "Line 1\nLine 2\nLine 3" })]);
            expect(result).toContain("Line 1 Line 2 Line 3");
            expect(result).not.toContain("Line 1\nLine 2");
        });
    });

    describe("escapePromptText (security)", () => {
        it("should escape HTML/XML entities in name", () => {
            const result = render([createMockNudge({ name: 'Nudge with <script> & "quotes"' })]);
            expect(result).toContain("&lt;script&gt;");
            expect(result).toContain("&amp;");
            expect(result).toContain("&quot;quotes&quot;");
            expect(result).not.toContain("<script>");
        });

        it("should escape HTML/XML entities in description", () => {
            const result = render([createMockNudge({ description: "Use <b>bold</b> & special chars" })]);
            expect(result).toContain("&lt;b&gt;bold&lt;/b&gt;");
            expect(result).toContain("&amp;");
            expect(result).not.toContain("<b>");
        });
    });

    describe("example usage section", () => {
        it("should include example delegate call", () => {
            const result = render([createMockNudge()]);
            expect(result).toContain("Example usage:");
            expect(result).toContain("delegate({");
            expect(result).toContain("nudges:");
        });

        it("should use first nudge event ID in example when nudges exist", () => {
            const result = render([
                createMockNudge({ eventId: "firstnudge12345678901234567890123456789012345678901234567890" }),
            ]);
            expect(result).toContain("firstnudge12...");
        });

        it("should use first skill event ID in example when only skills exist", () => {
            const result = render([], [
                createMockSkill({ eventId: "firstskill12345678901234567890123456789012345678901234567890" }),
            ]);
            expect(result).toContain("firstskill12...");
        });
    });

    describe("header content", () => {
        it("should explain what nudges are", () => {
            const result = render([createMockNudge()]);
            expect(result).toContain("modify tool availability");
            expect(result).toContain("only-tool");
            expect(result).toContain("allow-tool");
            expect(result).toContain("deny-tool");
        });

        it("should explain nudges inject context into system prompt", () => {
            const result = render([createMockNudge()]);
            expect(result).toContain("inject additional context");
            expect(result).toContain("system prompt");
        });

        it("should explain skills provide transient capabilities", () => {
            const result = render([], [createMockSkill()]);
            expect(result).toContain("transient capabilities");
            expect(result).toContain("without modifying tool availability");
        });
    });
});
