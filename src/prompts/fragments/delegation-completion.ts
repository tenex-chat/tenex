import type { PromptFragment } from "../core/types";

/**
 * Fragment for delegation completion instructions
 * Applied when an agent is reactivated after a delegated task completes.
 * Differentiates between partial completion (some pending) and full completion.
 */
export const delegationCompletionFragment: PromptFragment<{
    isDelegationCompletion?: boolean;
    hasPendingDelegations?: boolean;
}> = {
    id: "delegation-completion",
    priority: 95, // High priority to ensure agent sees this instruction
    template: (data) => {
        if (!data.isDelegationCompletion) return "";

        if (data.hasPendingDelegations) {
            return `
=== DELEGATION UPDATE ===

One or more delegated tasks have completed. The response(s) are in the conversation above.
You are still waiting for other delegations to complete.

You may:
- Acknowledge receipt of partial results
- Ask follow-up questions to completed agents
- Wait silently for remaining delegations
- Take other actions as appropriate

=== END UPDATE ===`;
        }

        return `
=== ALL DELEGATIONS COMPLETE ===

All delegated tasks have completed. The responses are in the conversation above.

Synthesize the results and respond to the user.

=== END NOTIFICATION ===`;
    },
};

// Note: Fragment is registered in the fragments/index.ts file
