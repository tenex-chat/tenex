import type { AgentInstance } from "@/agents/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Available agents fragment for specialists.
 * Shows coworkers they can hand off to.
 */
interface SpecialistAvailableAgentsArgs {
  agents: AgentInstance[];
  currentAgent: AgentInstance;
}

export const specialistAvailableAgentsFragment: PromptFragment<SpecialistAvailableAgentsArgs> = {
  id: "specialist-available-agents",
  priority: 15,
  template: ({ agents, currentAgent }) => {
    // Filter out current agent
    const coworkers = agents.filter((agent) => agent.pubkey !== currentAgent.pubkey);

    if (coworkers.length === 0) {
      return "## Available Agents\nNo other agents are available.";
    }

    const agentList = coworkers
      .map((agent) => {
        const parts = [`- **${agent.name}** (${agent.slug})`, `  Role: ${agent.role}`];

        if (agent.useCriteria) {
          parts.push(`  Use Criteria: ${agent.useCriteria}`);
        } else if (agent.description) {
          parts.push(`  Description: ${agent.description}`);
        }

        return parts.join("\n");
      })
      .join("\n\n");

    return `## Available Agents
You are part of a multi-agent system, these are agents immediately available in the system:

${agentList}`;
  },
};

// Register the fragment
fragmentRegistry.register(specialistAvailableAgentsFragment);
