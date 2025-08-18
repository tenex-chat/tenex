import type { AgentInstance } from "./types";
import { analyze } from "../tools/implementations/analyze";
import { lessonLearnTool } from "../tools/implementations/learn";
import { readPathTool } from "../tools/implementations/readPath";
import { completeTool } from "../tools/implementations/complete";
import { delegateTool } from "../tools/implementations/delegate";
import { PROJECT_MANAGER_AGENT_DEFINITION } from "./built-in/project-manager";
import { claudeCode } from "@/tools/implementations/claude_code";

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
        // analyze.name,
        claudeCode.name,
        completeTool.name,  // All agents can complete tasks
        delegateTool.name    // All agents can delegate to others
    ];

    // Special handling for project manager - ADD PM-specific tools
    if (agent.slug === PROJECT_MANAGER_AGENT) {
        // Add PM-specific tools to the base set
        const pmSpecificTools = [
            "write_context_file",
            "shell",
            "discover_capabilities",
            "agents_hire",
            "agents_discover",
            "nostr_projects",
            "delegate_phase", // EXCLUSIVE to PM - combines phase switching with delegation
        ].filter(tool => !tools.includes(tool));
        tools.push(...pmSpecificTools);
    }

    return tools;
}
