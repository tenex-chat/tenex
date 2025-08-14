import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import type { AgentInstance } from "@/agents/types";

/**
 * Identity fragment for orchestrator agents ONLY.
 * No conditionals, no isOrchestrator checks.
 */
interface OrchestratorIdentityArgs {
    agent: AgentInstance;
    projectTitle: string;
    projectOwnerPubkey: string;
}

export const orchestratorIdentityFragment: PromptFragment<OrchestratorIdentityArgs> = {
    id: "orchestrator-identity",
    priority: 1,
    template: ({ agent, projectTitle, projectOwnerPubkey }) => {
        const parts: string[] = [];
        
        // Orchestrator identity
        parts.push(`## Your Identity\n`);
        parts.push(`Your pubkey: ${agent.pubkey}`);
        parts.push("");
        
        if (agent.instructions) {
            parts.push(`## Your Instructions\n${agent.instructions}`);
        }
        
        // Project context
        parts.push([
            "## Project Context",
            `- Project Title: "${projectTitle}"`,
            `- Project Owner Pubkey: ${projectOwnerPubkey}`
        ].join('\n'));
        
        return parts.join('\n\n');
    }
};

// Register the fragment
fragmentRegistry.register(orchestratorIdentityFragment);