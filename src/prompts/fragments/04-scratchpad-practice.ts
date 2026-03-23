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

### Suggested entries

Use any key names that fit your task. Common patterns:

- **objective** - what you're trying to accomplish
- **findings** - what you've learned
- **next-steps** - what's left to do
- **errors** - exact error messages (build, lint, runtime)
- **types** - interfaces, type definitions, key signatures you need to reference
- **patterns** - code patterns, import styles, naming conventions from the codebase
- **files** - file paths and their purpose, or small file contents you need
- **commands** - shell commands that work, build scripts, test invocations
- **code** - working code samples, snippets to reuse, templates to follow
- **requirements** - exact user requests, constraints, and success criteria
- **completion-state** - what is already done, what must not be repeated, and what is still pending

### How to use it

- Rewrite entries to reflect current state, don't append chronologically
- Prefer compact current state over a long running log
- Once captured, prune the tool calls that produced the information
- If you've read something twice, that's a sign you should have captured it the first time
- Save user requirements, constraints, and completion state before you prune
- If a preserved request could look unresolved later, either keep the satisfying turn or record clearly that it is already done and must not be repeated

Update after every information-gathering burst, every side-effect, every shift in understanding.`,
};
