/**
 * Delegation Chain Fragment
 *
 * This fragment displays the delegation chain in the system prompt, showing
 * agents their position in the multi-agent workflow hierarchy.
 *
 * Example output:
 * ## Delegation Chain
 * ```
 * [User -> pm-wip] [conversation 4f69d3302cf2]
 *   -> [pm-wip -> execution-coordinator] [conversation 8a2bc1e45678]
 *     -> [execution-coordinator -> claude-code (you)] [conversation 1234567890ab]
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
    /** The ID of the current conversation */
    currentConversationId?: string;
}

export const delegationChainFragment: PromptFragment<DelegationChainArgs> = {
    id: "delegation-chain",
    priority: 5, // After identity (1) but before most other context
    template: ({ delegationChain, currentAgentPubkey, currentConversationId }) => {
        if (!delegationChain || delegationChain.length === 0) {
            return "";
        }

        const chainString = formatDelegationChain(delegationChain, currentAgentPubkey, currentConversationId);

        return `## Delegation Chain
\`\`\`
${chainString}
\`\`\`

This shows who initiated this request, how it reached you, and the conversation ID for each hop. The "(you)" marker indicates your position.
`;
    },
};
