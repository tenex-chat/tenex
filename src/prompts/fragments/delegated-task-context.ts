import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Context fragment for delegated tasks (NDKTask kind 1934)
 */
interface DelegatedTaskContextArgs {
  taskDescription: string;
}

export const delegatedTaskContextFragment: PromptFragment<DelegatedTaskContextArgs> = {
  id: "delegated-task-context",
  priority: 5, // Early priority to set context
  template: ({ taskDescription }) => {
    return `## Delegated Task Context

You have been assigned a specific task to complete:

**Task:** ${taskDescription}

Focus on completing this specific task efficiently and effectively.`;
  },
  validateArgs: (args): args is DelegatedTaskContextArgs => {
    return typeof (args as Record<string, unknown>).taskDescription === "string";
  },
  expectedArgs: "{ taskDescription: string }",
};

// Register the fragment
fragmentRegistry.register(delegatedTaskContextFragment);