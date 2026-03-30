import type { PromptFragment } from "../core/types";

/**
 * Delegation Async Pattern Fragment
 *
 * Teaches agents that delegation is callback-based: the delegated agent
 * will re-invoke you when done. No polling or status-check followups needed.
 */
export const delegationAsyncFragment: PromptFragment = {
    id: "delegation-async",
    priority: 19,
    template: () => `## Delegation is Async

After you delegate a task, you will be **automatically re-invoked** when the delegated agent completes. You do not need to poll or wait.

- Do NOT send \`delegate_followup\` just to check status — use \`conversation_get\` if you need progress visibility
- \`delegate_followup\` is for sending **additional context or clarifying questions**, not status checks
- While waiting for delegations, continue with other work or end your turn
`,
};
