import type { AgentInstance } from "@/agents/types";
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
        parts.push(`Your npub: ${agent.signer.npub}`);
        parts.push(
            `Your nsec: ${agent.signer.nsec} -- this is your real nsec and you CAN and SHOULD use it when you encounter a tool that needs an nsec.`
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
