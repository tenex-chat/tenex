/**
 * Delegation Chain Fragment
 *
 * This fragment displays the delegation chain in the system prompt, showing
 * agents their position in the multi-agent workflow hierarchy.
 *
 * Example output:
 * ## Delegation Chain
 * ```
 * User → pm-wip → execution-coordinator → claude-code (you)
 * ```
 */

import type { DelegationChainEntry } from "@/conversations/ConversationStore";
import type { PromptFragment } from "../core/types";
import { formatDelegationChain } from "@/utils/delegation-chain";

interface DelegationChainArgs {
    /** The delegation chain entries */
    delegationChain: DelegationChainEntry[];
    /** The pubkey of the current agent (to mark with "(you)") */
    currentAgentPubkey: string;
}

export const delegationChainFragment: PromptFragment<DelegationChainArgs> = {
    id: "delegation-chain",
    priority: 5, // After identity (1) but before most other context
    template: ({ delegationChain, currentAgentPubkey }) => {
        if (!delegationChain || delegationChain.length === 0) {
            return "";
        }

        const chainString = formatDelegationChain(delegationChain, currentAgentPubkey);

        return `## Delegation Chain
\`\`\`
${chainString}
\`\`\`

This shows who initiated this request and how it reached you. The "(you)" marker indicates your position.
`;
    },
};
