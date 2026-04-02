import type { PromptFragment } from "../core/types";

/**
 * Todo Usage Fragment
 *
 * Recommends agents establish a todo list when delegating tasks.
 * The delegation tools append a system reminder when no todos exist.
 */
export const TodoUsageFragment: PromptFragment = {
    id: "todo-before-delegation",
    priority: 17, // Right after delegation-tips (16)
    template: () => `## Todo List

When delegating tasks, a todo list helps you track progress and stay organized.

- Use \`todo_write()\` to outline your workflow plan before or after delegating
- Include anticipated delegations so progress is visible
- Mark your current task as in_progress when delegating
`,
};
