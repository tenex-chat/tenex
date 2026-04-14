import type { AgentInstance } from "@/agents/types";
import { shortenPubkey } from "@/utils/conversation-id";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Identity fragment for agents.
 */
interface AgentIdentityArgs {
    agent: AgentInstance;
}

export const agentIdentityFragment: PromptFragment<AgentIdentityArgs> = {
    id: "agent-identity",
    priority: 1,
    template: ({ agent }) => {
        const parts: string[] = [];
        const shortenedPubkey = shortenPubkey(agent.pubkey);

        // Identity
        parts.push("<agent-identity>");
        parts.push(`Your name: ${agent.slug} (${shortenedPubkey})`);
        if (agent.category) {
            parts.push(`Your category: ${agent.category}`);
        }
        parts.push("</agent-identity>");
        parts.push("");

        // Instructions
        if (agent.instructions) {
            parts.push(`<agent-instructions>\n${agent.instructions}\n</agent-instructions>`);
        }

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(agentIdentityFragment);
