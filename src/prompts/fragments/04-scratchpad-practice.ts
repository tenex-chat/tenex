import type { PromptFragment } from "../core/types";

/**
 * Static guidance for proactive scratchpad usage.
 * This is only included when scratchpad is available in the current execution.
 */
export const scratchpadPracticeFragment: PromptFragment<Record<string, never>> = {
    id: "scratchpad-practice",
    priority: 4,
    template: () => `<scratchpad-practice>
Your scratchpad is your working memory. Anything not in it will eventually disappear.

**Guiding question:** "If I had to continue this task with only my scratchpad and no tool history, would I have what I need?"

Default to capturing. When you read type definitions, see build errors, notice patterns, or receive user directions — capture them immediately. Don't wait to see if you'll need them.

**What to capture:** objective, requirements, findings, completion-state, next-steps, errors, types, patterns, files, user directions.

**How to maintain it:**
- Rewrite entries to reflect current state — don't append chronologically
- Prefer compact current state over a long running log
- Once captured, prune the tool calls that produced the information
- Update after information-gathering bursts, side-effects, requirement changes, and task transitions
</scratchpad-practice>`,
};
