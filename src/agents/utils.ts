import type { AgentInstance } from "./types";

/**
 * Check if an agent uses the Claude backend
 * @param agent The agent to check
 * @returns True if the agent uses Claude backend
 */
export const isClaudeBackend = (agent: AgentInstance): boolean => agent.backend === "claude";

/**
 * Check if an agent uses the routing backend
 * @param agent The agent to check
 * @returns True if the agent uses routing backend
 */
export const isRoutingBackend = (agent: AgentInstance): boolean => agent.backend === "routing";

/**
 * Check if an agent uses a toolless backend (Claude or routing)
 * @param agent The agent to check
 * @returns True if the agent uses a toolless backend
 */
export const isToollessBackend = (agent: AgentInstance): boolean => 
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
 * @param agents Map of agent slug to AgentInstance
 * @param agentName Name to search for
 * @returns The found agent or undefined
 */
export const findAgentByName = (agents: Map<string, AgentInstance>, agentName: string): AgentInstance | undefined => {
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
