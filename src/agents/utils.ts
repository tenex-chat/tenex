import type { Agent } from "./types";

export const isClaudeBackend = (agent: Agent): boolean => agent.backend === "claude";

export const isRoutingBackend = (agent: Agent): boolean => agent.backend === "routing";

export const isToollessBackend = (agent: Agent): boolean => 
    agent.backend === "claude" || agent.backend === "routing";

/**
 * Normalize an agent name to kebab-case
 * Handles common variations like "Project Manager" → "project-manager"
 * @param name The name to normalize
 * @returns The normalized name
 */
const normalizeAgentName = (name: string): string => {
    return name
        .toLowerCase()
        .replace(/\s+/g, '-')        // Replace spaces with hyphens
        .replace(/_+/g, '-')         // Replace underscores with hyphens
        .replace(/[^\w-]/g, '')      // Remove non-word characters except hyphens
        .replace(/-+/g, '-')         // Replace multiple hyphens with single hyphen
        .replace(/^-|-$/g, '');      // Remove leading/trailing hyphens
};

/**
 * Find an agent by name with case-insensitive and kebab-case normalization fallback
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
    
    // If still not found, try normalized kebab-case search
    if (!agent) {
        const normalizedName = normalizeAgentName(agentName);
        for (const [key, value] of agents.entries()) {
            if (normalizeAgentName(key) === normalizedName) {
                agent = value;
                break;
            }
        }
    }
    
    return agent;
};
