import { describe, expect, test } from "bun:test";
import { scratchpadPracticeFragment } from "../04-scratchpad-practice";

describe("scratchpad-practice fragment", () => {
    test("has the expected id and priority", () => {
        expect(scratchpadPracticeFragment.id).toBe("scratchpad-practice");
        expect(scratchpadPracticeFragment.priority).toBe(4);
    });

    test("describes proactive scratchpad usage with working memory framing", () => {
        const result = scratchpadPracticeFragment.template({});

        expect(result).toContain("Your scratchpad is your working memory.");
        expect(result).toContain("Anything not in it will eventually disappear.");
        expect(result).toContain("Default to capturing.");
    });

    test("includes suggested entry types for coding workflows", () => {
        const result = scratchpadPracticeFragment.template({});

        expect(result).toContain("**errors**");
        expect(result).toContain("**types**");
        expect(result).toContain("**code**");
        expect(result).toContain("**commands**");
        expect(result).toContain("**patterns**");
        expect(result).toContain("**requirements**");
        expect(result).toContain("**completion-state**");
    });

    test("includes guidance on pruning tool calls and preserving conversation state", () => {
        const result = scratchpadPracticeFragment.template({});

        expect(result).toContain("Prefer compact current state over a long running log");
        expect(result).toContain("prune the tool calls that produced the information");
        expect(result).toContain("read something twice");
        expect(result).toContain("Save user requirements, constraints, and completion state before you prune");
        expect(result).toContain("If a preserved request could look unresolved later");
    });
});
