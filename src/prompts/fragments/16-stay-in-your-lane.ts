import type { PromptFragment } from "../core/types";

/**
 * Delegation Tips Fragment
 *
 * Concise guidance on delegation style and async behavior.
 */
export const delegationTipsFragment: PromptFragment = {
    id: "delegation-tips",
    priority: 16,
    template: () => `## Delegation Tips

Delegate **what** needs to be done, not **how**. Provide context and constraints, but trust the delegatee's expertise — don't prescribe tools or step-by-step approaches.

- BAD: "Search for X, read files Y and Z, then modify function F with these changes..."
- GOOD: "Fix the auth bug in the login flow — it appears related to token validation."

Delegation is async — you are **automatically re-invoked** when the delegatee completes. Don't poll or send \`delegate_followup\` to check status; use \`conversation_get\` if you need progress visibility. \`delegate_followup\` is for sending additional context or clarifying questions.
`,
};
