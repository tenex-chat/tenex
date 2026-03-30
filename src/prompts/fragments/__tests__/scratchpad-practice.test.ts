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

    test("includes the guiding question", () => {
        const result = scratchpadPracticeFragment.template({});

        expect(result).toContain("If I had to continue this task with only my scratchpad and no tool history, would I have what I need?");
    });

    test("includes what-to-capture list", () => {
        const result = scratchpadPracticeFragment.template({});

        expect(result).toContain("objective");
        expect(result).toContain("requirements");
        expect(result).toContain("completion-state");
        expect(result).toContain("errors");
        expect(result).toContain("types");
        expect(result).toContain("patterns");
    });

    test("includes maintenance guidance", () => {
        const result = scratchpadPracticeFragment.template({});

        expect(result).toContain("Prefer compact current state over a long running log");
        expect(result).toContain("prune the tool calls that produced the information");
        expect(result).toContain("Rewrite entries to reflect current state");
    });
});
