import type { PromptFragment } from "../core/types";

/**
 * Static guidance for proactive scratchpad usage.
 * This is only included when scratchpad is available in the current execution.
 */
export const scratchpadPracticeFragment: PromptFragment<Record<string, never>> = {
    id: "scratchpad-practice",
    priority: 4,
    template: () => `## Scratchpad Practice

Your scratchpad is your working memory. Anything not in it will eventually disappear.

**Default to capturing.** When you read a file and see type definitions you might need - capture them. When a build fails with specific errors - capture them. When you notice a pattern you'll want to follow - capture it. Don't wait to see if you'll need it later; by then it may be gone.

Think of it as: "If I had to continue this task with only my scratchpad and no tool history, would I have what I need?"

Use it proactively and frequently, not only when context is tight. The point is to keep your active attention focused on what still matters, not to leave stale transcript hanging around "just in case."

### Suggested entries

Common scratchpad keys:

objective, requirements, findings, completion-state, next-steps, errors and missteps, types, patterns, files, commands, code, user questions, directions and comments.

Anything the user explicitly says should go in the scratchpad should be captured there, and anything you think might be relevant later should also go there. The more you capture, the more you can rely on it as your single source of truth.

Err on the side of over-capturing rather than under-capturing. Once the scratchpad safely carries what you need, prune stale transcript instead of leaving it around "just in case."

### How to use it

- Rewrite entries to reflect current state, don't append chronologically
- Prefer compact current state over a long running log
- Once captured, prune the tool calls that produced the information
- Save user requirements, constraints, and completion state before you prune
- If a preserved request could look unresolved later, either keep the satisfying turn or record clearly that it is already done and must not be repeated
- Do not wait for context pressure. Update after information-gathering bursts, side-effects, requirement changes, decisions, and task transitions

Update frequently enough that the scratchpad, not the stale transcript, is your source of truth.`,
};
