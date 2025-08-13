import type { AgentInstance } from "@/agents/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

// Available agents fragment - shows all agents available in the project
interface AvailableAgentsArgs {
    agents: AgentInstance[];
    currentAgent?: AgentInstance;
    currentAgentPubkey?: string;
}

export const availableAgentsFragment: PromptFragment<AvailableAgentsArgs> = {
    id: "available-agents",
    priority: 15,
    template: ({ agents, currentAgent, currentAgentPubkey }) => {
        if (agents.length === 0) {
            return "## Available Agents\nNo agents are currently available.";
        }

        // Filter out current agent if specified
        const currentPubkey = currentAgent?.pubkey || currentAgentPubkey;
        const availableForHandoff = currentPubkey
            ? agents.filter((agent) => agent.pubkey !== currentPubkey)
            : agents;

        if (availableForHandoff.length === 0) {
            return "## Available Agents\nNo other agents are available.";
        }

        const agentList = availableForHandoff
            .map((agent) => {
                const orchestratorIndicator = agent.isOrchestrator ? " (Orchestrator)" : "";
                let agentInfo = `- **${agent.name}**${orchestratorIndicator} (${agent.slug})\n  Role: ${agent.role}`;
                if (agent.useCriteria) {
                    agentInfo += `\n  Use Criteria: ${agent.useCriteria}`;
                } else if (agent.description) {
                    agentInfo += `\n  Description: ${agent.description}`;
                }
                return `${agentInfo}\n`;
            })
            .join("\n\n");

        // Determine if current agent is an orchestrator
        const currentAgentObj =
            currentAgent ||
            (currentAgentPubkey ? agents.find((a) => a.pubkey === currentAgentPubkey) : null);
        const isCurrentAgentOrchestrator = currentAgentObj?.isOrchestrator || false;

        const preface = isCurrentAgentOrchestrator
            ? "The agents available to you in this system to involve in the workflow are:"
            : "You are part of a multi-agent system, here are your coworkers:";

        // Add role-specific guidance
        const roleGuidance = isCurrentAgentOrchestrator
            ? `

As Orchestrator:
- You coordinate work between different types of agents
- Implementation work MUST go to the Executor agent
- Planning work goes to the Planner agent
- Domain expertise comes from specialist agents (advisory only)
- Remember: Only the Executor can modify the system`
            : currentAgentObj?.slug === 'executor'
            ? `

As the Executor:
- You are the ONLY agent that can modify files and system state
- You implement plans from the Planner
- You execute recommendations from expert agents
- Focus on implementation quality and following project conventions`
            : currentAgentObj?.slug === 'planner'
            ? `

As the Planner:
- You create architectural plans and strategies
- You CANNOT modify any files - only create plans
- Your plans will be implemented by the Executor
- Focus on breaking down complex tasks into clear steps`
            : `

As a Specialist/Expert:
- You provide domain expertise and recommendations ONLY
- Your advice will be implemented by the Executor agent
- Focus on your area of expertise
- Use the complete tool when you finish providing feedback`;

        return `## Available Agents
${preface}

${agentList}${roleGuidance}`;
    },
    validateArgs: (args): args is AvailableAgentsArgs => {
        return (
            typeof args === "object" &&
            args !== null &&
            Array.isArray((args as AvailableAgentsArgs).agents)
        );
    },
};

// Register the fragment
fragmentRegistry.register(availableAgentsFragment);
