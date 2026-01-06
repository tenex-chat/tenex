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

**When to use \`todo_add()\`:**
- Complex multi-step tasks (3+ distinct steps)
- Non-trivial work requiring planning
- When given multiple tasks or requests
- Breaking down large requests into trackable sub-tasks
- Multi-step debugging or investigation processes

**When NOT to use todos:**
- Single, straightforward tasks
- Informational or conversational requests
- Quick tasks completable in one interaction

**Task management rules:**
- Only ONE task should be \`in_progress\` at a time
- Mark tasks \`done\` immediately after completing (don't batch completions)
- Use \`skipped\` with a reason if a task becomes irrelevant
`,
};
