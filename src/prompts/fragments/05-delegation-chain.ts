/**
 * Delegation Chain Fragment
 *
 * This fragment displays the delegation chain in the system prompt, showing
 * agents their position in the multi-agent workflow hierarchy.
 *
 * Example output:
 * ## Delegation Chain
 * ```
 * [User -> architect-orchestrator] [conversation 4f69d3302cf2]
 *   -> [architect-orchestrator -> execution-coordinator] [conversation 8a2bc1e45678]
 *     -> [execution-coordinator -> claude-code (you)] [conversation 1234567890ab]
 * ```
 */

import type { DelegationChainEntry } from "@/conversations/types";
import type { PromptFragment } from "../core/types";
import { formatDelegationChain } from "@/utils/delegation-chain";

interface DelegationChainArgs {
    /** The delegation chain entries (each with full conversation ID stored) */
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
