import { describe, expect, it } from "bun:test";
import type { WhitelistItem } from "@/services/nudge";
import { NDKKind } from "@/nostr/kinds";
import { availableNudgesAndSkillsFragment } from "../13-available-nudges";

/**
 * Create a mock WhitelistItem for testing (nudge)
 */
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

/**
 * Create a mock WhitelistItem for testing (skill)
 */
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

describe("availableNudgesAndSkillsFragment (combined nudges + skills)", () => {
    describe("empty state", () => {
        it("should return empty string when both are undefined", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: undefined,
                availableSkills: undefined,
            });
            expect(result).toBe("");
        });

        it("should return empty string when both are empty arrays", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [],
                availableSkills: [],
            });
            expect(result).toBe("");
        });

        it("should return empty string when nudges is empty and skills is undefined", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [],
                availableSkills: undefined,
            });
            expect(result).toBe("");
        });
    });

    describe("heading", () => {
        it("should use 'Available Nudges and Skills' heading with nudges only", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
                availableSkills: [],
            });
            expect(result).toContain("## Available Nudges and Skills");
        });

        it("should use 'Available Nudges and Skills' heading with skills only", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [],
                availableSkills: [createMockSkill()],
            });
            expect(result).toContain("## Available Nudges and Skills");
        });

        it("should use 'Available Nudges and Skills' heading with both", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
                availableSkills: [createMockSkill()],
            });
            expect(result).toContain("## Available Nudges and Skills");
        });
    });

    describe("subsection headers", () => {
        it("should NOT show subsection headers when only nudges exist", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
                availableSkills: [],
            });
            expect(result).not.toContain("### Nudges");
            expect(result).not.toContain("### Skills");
            expect(result).toContain("**Test Nudge**");
        });

        it("should NOT show subsection headers when only skills exist", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [],
                availableSkills: [createMockSkill()],
            });
            expect(result).not.toContain("### Nudges");
            expect(result).not.toContain("### Skills");
            expect(result).toContain("**Test Skill**");
        });

        it("should show BOTH subsection headers when both nudges and skills exist", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
                availableSkills: [createMockSkill()],
            });
            expect(result).toContain("### Nudges");
            expect(result).toContain("### Skills");
        });
    });

    describe("nudge-only rendering", () => {
        it("should render a single nudge correctly", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
            });
            expect(result).toContain("**Test Nudge**");
            expect(result).toContain("Test description");
            expect(result).toContain("(abc123def456)");
        });

        it("should render multiple nudges", () => {
            const nudges = [
                createMockNudge({ eventId: "event1", name: "First Nudge" }),
                createMockNudge({ eventId: "event2", name: "Second Nudge" }),
            ];
            const result = availableNudgesAndSkillsFragment.template({ availableNudges: nudges });
            expect(result).toContain("**First Nudge**");
            expect(result).toContain("**Second Nudge**");
        });

        it("should use truncated event ID when name is missing", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge({ name: undefined })],
            });
            expect(result).toContain("**abc123def456**");
        });

        it("should show 'No description' when description is missing", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge({ description: undefined })],
            });
            expect(result).toContain("No description");
        });
    });

    describe("skill-only rendering", () => {
        it("should render a single skill correctly", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [],
                availableSkills: [createMockSkill()],
            });
            expect(result).toContain("**Test Skill**");
            expect(result).toContain("Test skill description");
            expect(result).toContain("(skill123def4)");
        });

        it("should render multiple skills", () => {
            const skills = [
                createMockSkill({ eventId: "event1", name: "First Skill" }),
                createMockSkill({ eventId: "event2", name: "Second Skill" }),
            ];
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [],
                availableSkills: skills,
            });
            expect(result).toContain("**First Skill**");
            expect(result).toContain("**Second Skill**");
        });
    });

    describe("combined rendering", () => {
        it("should render both nudges and skills with subsection headers", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
                availableSkills: [createMockSkill()],
            });

            expect(result).toContain("## Available Nudges and Skills");
            expect(result).toContain("### Nudges");
            expect(result).toContain("**Test Nudge**");
            expect(result).toContain("### Skills");
            expect(result).toContain("**Test Skill**");
        });

        it("should place nudges before skills", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
                availableSkills: [createMockSkill()],
            });

            const nudgesPos = result.indexOf("### Nudges");
            const skillsPos = result.indexOf("### Skills");
            expect(nudgesPos).toBeLessThan(skillsPos);
        });
    });

    describe("description truncation (presentation layer)", () => {
        it("should truncate descriptions longer than 150 characters", () => {
            const longDescription = "A".repeat(200);
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge({ description: longDescription })],
            });
            expect(result).toContain("A".repeat(150));
            expect(result).not.toContain("A".repeat(151));
        });

        it("should not truncate descriptions shorter than 150 characters", () => {
            const shortDescription = "B".repeat(100);
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge({ description: shortDescription })],
            });
            expect(result).toContain(shortDescription);
        });

        it("should replace newlines with spaces in descriptions", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge({ description: "Line 1\nLine 2\nLine 3" })],
            });
            expect(result).toContain("Line 1 Line 2 Line 3");
            expect(result).not.toContain("Line 1\nLine 2");
        });
    });

    describe("escapePromptText (security)", () => {
        it("should escape HTML/XML entities in name", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge({ name: 'Nudge with <script> & "quotes"' })],
            });
            expect(result).toContain("&lt;script&gt;");
            expect(result).toContain("&amp;");
            expect(result).toContain("&quot;quotes&quot;");
            expect(result).not.toContain("<script>");
        });

        it("should escape HTML/XML entities in description", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge({ description: "Use <b>bold</b> & special chars" })],
            });
            expect(result).toContain("&lt;b&gt;bold&lt;/b&gt;");
            expect(result).toContain("&amp;");
            expect(result).not.toContain("<b>");
        });
    });

    describe("example usage section", () => {
        it("should include example delegate call", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
            });
            expect(result).toContain("Example usage:");
            expect(result).toContain("delegate({");
            expect(result).toContain("nudges:");
        });

        it("should use first nudge event ID in example when nudges exist", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [
                    createMockNudge({ eventId: "firstnudge12345678901234567890123456789012345678901234567890" }),
                ],
            });
            expect(result).toContain("firstnudge12...");
        });

        it("should use first skill event ID in example when only skills exist", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [],
                availableSkills: [
                    createMockSkill({ eventId: "firstskill12345678901234567890123456789012345678901234567890" }),
                ],
            });
            expect(result).toContain("firstskill12...");
        });
    });

    describe("header content", () => {
        it("should explain what nudges are", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
            });
            expect(result).toContain("modify tool availability");
            expect(result).toContain("only-tool");
            expect(result).toContain("allow-tool");
            expect(result).toContain("deny-tool");
        });

        it("should explain nudges inject context into system prompt", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableNudges: [createMockNudge()],
            });
            expect(result).toContain("inject additional context");
            expect(result).toContain("system prompt");
        });

        it("should explain skills provide transient capabilities", () => {
            const result = availableNudgesAndSkillsFragment.template({
                availableSkills: [createMockSkill()],
            });
            expect(result).toContain("transient capabilities");
            expect(result).toContain("without modifying tool availability");
        });
    });

    describe("validateArgs", () => {
        it("should accept empty object (optional fields)", () => {
            expect(availableNudgesAndSkillsFragment.validateArgs({})).toBe(true);
        });

        it("should accept undefined availableNudges", () => {
            expect(availableNudgesAndSkillsFragment.validateArgs({ availableNudges: undefined })).toBe(true);
        });

        it("should accept undefined availableSkills", () => {
            expect(availableNudgesAndSkillsFragment.validateArgs({ availableSkills: undefined })).toBe(true);
        });

        it("should accept valid arrays for both", () => {
            expect(availableNudgesAndSkillsFragment.validateArgs({
                availableNudges: [createMockNudge()],
                availableSkills: [createMockSkill()],
            })).toBe(true);
        });

        it("should accept empty arrays for both", () => {
            expect(availableNudgesAndSkillsFragment.validateArgs({
                availableNudges: [],
                availableSkills: [],
            })).toBe(true);
        });

        it("should reject null", () => {
            expect(availableNudgesAndSkillsFragment.validateArgs(null)).toBe(false);
        });

        it("should reject non-object", () => {
            expect(availableNudgesAndSkillsFragment.validateArgs("string")).toBe(false);
            expect(availableNudgesAndSkillsFragment.validateArgs(123)).toBe(false);
        });

        it("should reject non-array availableNudges", () => {
            expect(availableNudgesAndSkillsFragment.validateArgs({
                availableNudges: "not an array",
            })).toBe(false);
        });

        it("should reject non-array availableSkills", () => {
            expect(availableNudgesAndSkillsFragment.validateArgs({
                availableSkills: "not an array",
            })).toBe(false);
        });
    });
});
