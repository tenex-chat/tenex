import type { AgentInstance } from "./types";
import { analyze } from "../tools/implementations/analyze";
import { lessonLearnTool } from "../tools/implementations/learn";
import { readPathTool } from "../tools/implementations/readPath";
import { completeTool } from "../tools/implementations/complete";
import { delegateTool } from "../tools/implementations/delegate";
import { PROJECT_MANAGER_AGENT_DEFINITION } from "./built-in/project-manager";

// Agent slug constants
export const PROJECT_MANAGER_AGENT = "project-manager" as const;

/**
 * Get all available tools for an agent based on their role
 * All agents now have access to delegate for peer-to-peer collaboration
 */
export function getDefaultToolsForAgent(agent: AgentInstance): string[] {
    // Base tools for all agents
    const tools = [
        readPathTool.name, 
        lessonLearnTool.name, 
        analyze.name,
        completeTool.name,  // All agents can complete tasks
        delegateTool.name    // All agents can delegate to others
    ];

    // Special handling for project manager - ADD to defaults, don't replace
    if (agent.slug === PROJECT_MANAGER_AGENT && PROJECT_MANAGER_AGENT_DEFINITION.tools) {
        // Add PM-specific tools to the base set
        const pmSpecificTools = PROJECT_MANAGER_AGENT_DEFINITION.tools.filter(
            tool => !tools.includes(tool)
        );
        tools.push(...pmSpecificTools);
    }

    return tools;
}
