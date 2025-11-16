import type { AgentInstance } from "@/agents/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Available agents fragment.
 * Shows coworkers they can hand off to.
 */
interface AvailableAgentsArgs {
    agents: AgentInstance[];
    currentAgent: AgentInstance;
    projectManagerPubkey?: string;
}

export const availableAgentsFragment: PromptFragment<AvailableAgentsArgs> = {
    id: "available-agents",
    priority: 15,
    template: ({ agents, currentAgent, projectManagerPubkey }) => {
        // Filter out current agent
        const coworkers = agents.filter((agent) => agent.pubkey !== currentAgent.pubkey);

        if (coworkers.length === 0) {
            return "## Available Agents\nNo other agents are available.";
        }

        const agentList = coworkers
            .map((agent) => {
                // Check if this agent is the current PM of the project
                const isPM = projectManagerPubkey && agent.pubkey === projectManagerPubkey;
                const roleDisplay = isPM ? `${agent.role} [PM]` : agent.role;
                const parts = [`(${agent.slug})`, `  Role: ${roleDisplay}`];

                if (agent.useCriteria) {
                    parts.push(`  Use Criteria: ${agent.useCriteria}`);
                } else if (agent.description) {
                    parts.push(`  Description: ${agent.description}`);
                }

                // Add phase management information if applicable
                if (agent.phases && Object.keys(agent.phases).length > 0) {
                    const phaseNames = Object.keys(agent.phases).join(", ");
                    parts.push(`  Manages phases: ${phaseNames}`);
                }

                return parts.join("\n");
            })
            .join("\n\n");

        return `## Available Agents
You are part of a multi-agent system, these are agents immediately available in the system:

${agentList}

The PM of this project only has knowledge of *this* project.`;
    },
};

// Register the fragment
fragmentRegistry.register(availableAgentsFragment);
