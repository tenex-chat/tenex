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

        // Identity
        parts.push("<agent-identity>");
        parts.push(`Your name: ${agent.name} (${agent.slug})`);
        if (agent.role) {
            parts.push(`Your role: ${agent.role}`);
        }
        parts.push(`Your shortened pubkey: ${shortenPubkey(agent.pubkey)}`);
        parts.push(
            `Your nsec is available in your home directory's .env file as NSEC. Use it when you encounter a tool that needs an nsec.`
        );
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
