import type { Agent } from "./types";

export const isClaudeBackend = (agent: Agent): boolean => agent.backend === "claude";

export const isRoutingBackend = (agent: Agent): boolean => agent.backend === "routing";

export const isToollessBackend = (agent: Agent): boolean => 
    agent.backend === "claude" || agent.backend === "routing";

/**
 * Find an agent by name with case-insensitive fallback
 * @param agents Map of agent slug to Agent
 * @param agentName Name to search for
 * @returns The found agent or undefined
 */
export const findAgentByName = (agents: Map<string, Agent>, agentName: string): Agent | undefined => {
    // Try exact match first
    let agent = agents.get(agentName);
    
    // If not found, try case-insensitive search
    if (!agent) {
        const lowerCaseName = agentName.toLowerCase();
        for (const [key, value] of agents.entries()) {
            if (key.toLowerCase() === lowerCaseName) {
                agent = value;
                break;
            }
        }
    }
    
    return agent;
};
