import type { PromptFragment } from "../core/types";

/**
 * Todo Usage Fragment
 *
 * Instructs agents to establish a todo list before delegating complex tasks.
 * This ensures agents have a clear workflow plan visible before spawning child work.
 * Simple, single-step delegations are exempt from this requirement.
 */
export const TodoUsageFragment: PromptFragment = {
    id: "todo-before-delegation",
    priority: 17, // Right after stay-in-your-lane (16)
    template: () => `## Todo List

**Establish your todo list BEFORE delegating complex or multi-step tasks.**

Before using any delegation tool:

1. **Create your todo list first** - Use \`todo_write()\` to outline your workflow plan; if unsure about what the workflow will be, write in the todo list the decisions that will be needed to be made to establish the workflow.
2. **Include anticipated delegations** - Your todo list should reflect the work you plan to delegate
3. **Mark your current task as in_progress** - Show what you're working on when delegating

**Skipping the todo list for complex delegations may result in system warnings.**
`,
};
