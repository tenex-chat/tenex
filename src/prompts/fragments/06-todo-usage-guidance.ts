import type { PromptFragment } from "../core/types";

/**
 * Static guidance about when to use todo tools.
 * This is shown to all agents that have todo_add in their tools array.
 * Complements 06-agent-todos.ts which shows the actual todo list.
 */
export const todoUsageGuidanceFragment: PromptFragment = {
    id: "todo-usage-guidance",
    priority: 6, // Same priority as agent-todos, shown before the list
    template: () => `## Task Tracking with Todos

**IMPORTANT: Use \`todo_write()\` liberally and proactively!**

Creating a todo list helps you stay organized, shows your progress to observers, and ensures nothing gets forgotten. It's always better to have a simple todo list than none at all.

**Best Practice: Create todos EARLY in your work:**
- As soon as you receive a task, create a todo list
- Even 1-2 item lists are valuable for tracking progress
- Update your todos as you work (mark in_progress, done, add new items)
- Delegation to other agents REQUIRES having a todo list first

**Good candidates for todos:**
- Any task you'll spend more than a few seconds on
- Multi-step work (even just 2 steps)
- Tasks that involve file changes, tool calls, or research
- Work that others may want to observe or track
- Before delegating to other agents

**Task management rules:**
- Only ONE task should be \`in_progress\` at a time
- Mark tasks \`done\` immediately after completing (don't batch completions)
- Use \`skipped\` with a reason if a task becomes irrelevant
- Keep your todo list updated as work progresses
`,
};
