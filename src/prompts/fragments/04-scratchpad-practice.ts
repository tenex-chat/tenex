import type { PromptFragment } from "../core/types";

/**
 * Static guidance for proactive scratchpad usage.
 * This is only included when scratchpad is available in the current execution.
 */
export const scratchpadPracticeFragment: PromptFragment<Record<string, never>> = {
    id: "scratchpad-practice",
    priority: 4,
    template: () => `## Scratchpad Practice

Your scratchpad is your primary working state for this run.

Use \`scratchpad(...)\` proactively, not only when context is tight.

Update it whenever:
- you finish an information-gathering burst
- your understanding of the task changes
- you take any side-effecting action
- you hand work off or receive delegated results
- you are about to prune stale context

Keep it current by rewriting it in place.
Do not maintain a chronological log unless the sequence itself matters.

Prefer compact current state:
- key/value entries for the current objective, thesis, findings, side effects, open questions, or next steps
- freeform notes only when structure would get in the way

You may choose any entry names that fit the task.

Once important tool results are captured in the scratchpad, remove stale tool calls from active context.`,
};
