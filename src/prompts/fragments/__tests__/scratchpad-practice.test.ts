import { describe, expect, test } from "bun:test";
import { scratchpadPracticeFragment } from "../04-scratchpad-practice";

describe("scratchpad-practice fragment", () => {
    test("has the expected id and priority", () => {
        expect(scratchpadPracticeFragment.id).toBe("scratchpad-practice");
        expect(scratchpadPracticeFragment.priority).toBe(4);
    });

    test("conveys working memory framing and current-state maintenance", () => {
        const result = scratchpadPracticeFragment.template({});

        expect(result).toContain("Your scratchpad is your working memory.");
        expect(result).toContain("Anything not captured will be lost.");
        expect(result).toContain("current state");
        expect(result).toContain("not a running log");
    });
});
