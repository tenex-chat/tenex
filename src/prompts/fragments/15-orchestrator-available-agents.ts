import type { AgentInstance } from "@/agents/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Available agents fragment for ORCHESTRATOR.
 * Shows agents it can route to.
 * No conditionals, no isOrchestrator checks.
 */
interface OrchestratorAvailableAgentsArgs {
    agents: AgentInstance[];
}

export const orchestratorAvailableAgentsFragment: PromptFragment<OrchestratorAvailableAgentsArgs> = {
    id: "orchestrator-available-agents",
    priority: 15,
    template: ({ agents }) => {
        // Orchestrator sees all agents except itself
        const availableAgents = agents.filter((agent) => !agent.isOrchestrator);

        if (availableAgents.length === 0) {
            return "## Available Agents\nNo agents are currently available for routing.";
        }

        const agentList = availableAgents
            .map((agent) => {
                let agentInfo = `- **${agent.name}** (${agent.slug})\n  Role: ${agent.role}`;
                if (agent.useCriteria) {
                    agentInfo += `\n  Use Criteria: ${agent.useCriteria}`;
                } else if (agent.description) {
                    agentInfo += `\n  Description: ${agent.description}`;
                }
                return agentInfo;
            })
            .join("\n\n");

        return `## Available Agents
The agents available to you in this system to involve in the workflow are:

${agentList}

As Orchestrator:
- You coordinate work between different types of agents
- Implementation work MUST go to the Executor agent
- Planning work goes to the Planner agent
- Domain expertise comes from specialist agents (advisory only)
- Remember: Only the Executor can modify the system`;
    }
};

// Register the fragment
fragmentRegistry.register(orchestratorAvailableAgentsFragment);