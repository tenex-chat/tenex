import { describe, expect, test } from "bun:test";
import { scratchpadPracticeFragment } from "../04-scratchpad-practice";

describe("scratchpad-practice fragment", () => {
    test("has the expected id and priority", () => {
        expect(scratchpadPracticeFragment.id).toBe("scratchpad-practice");
        expect(scratchpadPracticeFragment.priority).toBe(4);
    });

    test("describes proactive scratchpad usage and flexible key names", () => {
        const result = scratchpadPracticeFragment.template({});

        expect(result).toContain("Your scratchpad is your primary working state for this run.");
        expect(result).toContain("Use `scratchpad(...)` proactively");
        expect(result).toContain("Keep it current by rewriting it in place.");
        expect(result).toContain("Prefer compact current state:");
        expect(result).toContain("remove stale tool calls from active context");
    });
});
