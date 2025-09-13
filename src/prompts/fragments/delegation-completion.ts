import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Fragment for delegation completion instructions
 * Applied when an agent is reactivated after a delegated task completes
 */
export const delegationCompletionFragment: PromptFragment = {
  id: "delegation-completion",
  priority: 95, // High priority to ensure agent sees this instruction
  template: (data: { isDelegationCompletion?: boolean }) => {
    if (!data.isDelegationCompletion) return "";

    return `
=== CRITICAL: DELEGATION COMPLETION NOTIFICATION ===

STOP! A delegated task has JUST BEEN COMPLETED. The response is in the conversation above.

YOU MUST:
1. Pass the result back to the user in your response
2. Do NOT use ANY tools
3. Do NOT delegate again - the task is ALREADY DONE

THE TASK IS COMPLETE. DO NOT REPEAT IT.

Simply respond with the result from the conversation above.

DO NOT use delegate(), delegate_phase(), or any other tool.

=== END CRITICAL NOTIFICATION ===`;
  },
};

// Note: Fragment is registered in the fragments/index.ts file