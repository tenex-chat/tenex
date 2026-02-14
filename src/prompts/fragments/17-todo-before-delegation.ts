import type { PromptFragment } from "../core/types";

/**
 * Todo Before Delegation Fragment
 *
 * Instructs agents to establish a todo list before delegating complex tasks.
 * This ensures agents have a clear workflow plan visible before spawning child work.
 * Simple, single-step delegations are exempt from this requirement.
 */
export const todoBeforeDelegationFragment: PromptFragment = {
    id: "todo-before-delegation",
    priority: 17, // Right after stay-in-your-lane (16)
    template: () => `## Todo List Before Delegation

**Establish your todo list BEFORE delegating complex or multi-step tasks.**

Before using any delegation tool for non-trivial work:

1. **Create your todo list first** - Use \`todo_write()\` to outline your workflow plan
2. **Include anticipated delegations** - Your todo list should reflect the work you plan to delegate
3. **Mark your current task as in_progress** - Show what you're working on when delegating

**When this applies:**
- Multi-step tasks involving multiple delegations
- Complex work requiring coordination across agents
- Tasks where progress tracking matters

**When you can skip this:**
- Simple, single-step delegations (e.g., quick lookups, straightforward queries)
- Follow-up messages to existing delegations

**Why this matters:**
- Your workflow plan becomes visible to observers and the system
- It prevents orphaned delegations without context
- It enables better coordination and status tracking across agents

**Skipping the todo list for complex delegations may result in system warnings.**
`,
};
