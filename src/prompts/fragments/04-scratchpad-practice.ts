import type { PromptFragment } from "../core/types";

/**
 * Static guidance for proactive scratchpad usage.
 * This is only included when scratchpad is available in the current execution.
 */
export const scratchpadPracticeFragment: PromptFragment<Record<string, never>> = {
    id: "scratchpad-practice",
    priority: 4,
    template: () => `<scratchpad-practice>
Your scratchpad is your working memory. Anything not captured will be lost. Keep it as current state — not a running log — and update it as your understanding evolves.
</scratchpad-practice>`,
};
