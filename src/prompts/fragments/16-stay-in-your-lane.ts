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

Delegate what needs to be done, not how — provide context but trust the delegatee's expertise. Delegation is async: you are automatically re-invoked when the delegatee completes; \`delegate_followup\` is for additional context or clarifying questions only.
`,
};
