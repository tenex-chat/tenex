import { describe, expect, it } from "bun:test";
import type { WhitelistItem } from "@/services/nudge";
import { NDKKind } from "@/nostr/kinds";
import { availableNudgesFragment } from "../13-available-nudges";

/**
 * Create a mock WhitelistItem for testing
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

describe("availableNudgesFragment", () => {
    describe("empty state", () => {
        it("should return empty string when availableNudges is undefined", () => {
            const result = availableNudgesFragment.template({ availableNudges: undefined as unknown as WhitelistItem[] });
            expect(result).toBe("");
        });

        it("should return empty string when availableNudges is empty array", () => {
            const result = availableNudgesFragment.template({ availableNudges: [] });
            expect(result).toBe("");
        });
    });

    describe("nudge list rendering", () => {
        it("should render a single nudge correctly", () => {
            const nudges: WhitelistItem[] = [createMockNudge()];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            expect(result).toContain("## Available Nudges");
            expect(result).toContain("**Test Nudge**");
            expect(result).toContain("Test description");
            expect(result).toContain("(abc123def456)"); // Truncated event ID
        });

        it("should render multiple nudges", () => {
            const nudges: WhitelistItem[] = [
                createMockNudge({ eventId: "event1", name: "First Nudge" }),
                createMockNudge({ eventId: "event2", name: "Second Nudge" }),
            ];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            expect(result).toContain("**First Nudge**");
            expect(result).toContain("**Second Nudge**");
        });

        it("should use truncated event ID when name is missing", () => {
            const nudges: WhitelistItem[] = [
                createMockNudge({ name: undefined }),
            ];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            // Should use first 12 chars of event ID as fallback name
            expect(result).toContain("**abc123def456**");
        });

        it("should show 'No description' when description is missing", () => {
            const nudges: WhitelistItem[] = [
                createMockNudge({ description: undefined }),
            ];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            expect(result).toContain("No description");
        });
    });

    describe("description truncation (presentation layer)", () => {
        it("should truncate descriptions longer than 150 characters", () => {
            const longDescription = "A".repeat(200);
            const nudges: WhitelistItem[] = [
                createMockNudge({ description: longDescription }),
            ];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            // Should be truncated to 150 chars
            expect(result).toContain("A".repeat(150));
            expect(result).not.toContain("A".repeat(151));
        });

        it("should not truncate descriptions shorter than 150 characters", () => {
            const shortDescription = "B".repeat(100);
            const nudges: WhitelistItem[] = [
                createMockNudge({ description: shortDescription }),
            ];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            expect(result).toContain(shortDescription);
        });

        it("should replace newlines with spaces in descriptions", () => {
            const descriptionWithNewlines = "Line 1\nLine 2\nLine 3";
            const nudges: WhitelistItem[] = [
                createMockNudge({ description: descriptionWithNewlines }),
            ];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            // Should have replaced newlines with spaces in the description
            expect(result).toContain("Line 1 Line 2 Line 3");
            // The description should not contain the original newline pattern
            expect(result).not.toContain("Line 1\nLine 2");
        });
    });

    describe("escapePromptText (security)", () => {
        it("should escape HTML/XML entities in name", () => {
            const nudges: WhitelistItem[] = [
                createMockNudge({ name: 'Nudge with <script> & "quotes"' }),
            ];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            expect(result).toContain("&lt;script&gt;");
            expect(result).toContain("&amp;");
            expect(result).toContain("&quot;quotes&quot;");
            expect(result).not.toContain("<script>");
        });

        it("should escape HTML/XML entities in description", () => {
            const nudges: WhitelistItem[] = [
                createMockNudge({ description: "Use <b>bold</b> & special chars" }),
            ];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            expect(result).toContain("&lt;b&gt;bold&lt;/b&gt;");
            expect(result).toContain("&amp;");
            expect(result).not.toContain("<b>");
        });
    });

    describe("example usage section", () => {
        it("should include example delegate call", () => {
            const nudges: WhitelistItem[] = [createMockNudge()];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            expect(result).toContain("Example usage:");
            expect(result).toContain("delegate({");
            expect(result).toContain("nudges:");
        });

        it("should use first nudge event ID in example", () => {
            const nudges: WhitelistItem[] = [
                createMockNudge({ eventId: "firstnudge12345678901234567890123456789012345678901234567890" }),
            ];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            // Example should use truncated ID of first nudge
            expect(result).toContain("firstnudge12...");
        });
    });

    describe("header content", () => {
        it("should explain what nudges are", () => {
            const nudges: WhitelistItem[] = [createMockNudge()];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            expect(result).toContain("modify tool availability");
            expect(result).toContain("only-tool");
            expect(result).toContain("allow-tool");
            expect(result).toContain("deny-tool");
        });

        it("should explain nudges inject context into system prompt", () => {
            const nudges: WhitelistItem[] = [createMockNudge()];

            const result = availableNudgesFragment.template({ availableNudges: nudges });

            expect(result).toContain("inject additional context");
            expect(result).toContain("system prompt");
        });
    });

    describe("validateArgs", () => {
        it("should accept empty object (optional field)", () => {
            expect(availableNudgesFragment.validateArgs({})).toBe(true);
        });

        it("should accept undefined availableNudges", () => {
            expect(availableNudgesFragment.validateArgs({ availableNudges: undefined })).toBe(true);
        });

        it("should accept valid availableNudges array", () => {
            expect(availableNudgesFragment.validateArgs({
                availableNudges: [createMockNudge()],
            })).toBe(true);
        });

        it("should accept empty availableNudges array", () => {
            expect(availableNudgesFragment.validateArgs({
                availableNudges: [],
            })).toBe(true);
        });

        it("should reject null", () => {
            expect(availableNudgesFragment.validateArgs(null)).toBe(false);
        });

        it("should reject non-object", () => {
            expect(availableNudgesFragment.validateArgs("string")).toBe(false);
            expect(availableNudgesFragment.validateArgs(123)).toBe(false);
        });

        it("should reject non-array availableNudges", () => {
            expect(availableNudgesFragment.validateArgs({
                availableNudges: "not an array",
            })).toBe(false);
        });
    });
});
