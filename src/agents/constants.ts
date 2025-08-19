import type { AgentInstance } from "./types";
import { lessonLearnTool } from "../tools/implementations/learn";
import { readPathTool } from "../tools/implementations/readPath";
import { completeTool } from "../tools/implementations/complete";
import { delegateTool } from "../tools/implementations/delegate";
import { claudeCode } from "@/tools/implementations/claude_code";

// Agent slug constants
export const PROJECT_MANAGER_AGENT = "project-manager" as const;

/**
 * Get all available tools for an agent based on their role
 * All agents now have access to delegate for peer-to-peer collaboration
 */
export function getDefaultToolsForAgent(agent: AgentInstance): string[] {
    // Special handling for project manager - different tool set
    if (agent.slug === PROJECT_MANAGER_AGENT) {
        // PM has delegate_phase instead of delegate
        return [
            readPathTool.name,
            lessonLearnTool.name,
            claudeCode.name,
            completeTool.name,
            "write_context_file",
            "shell",
            "discover_capabilities",
            "agents_hire",
            "agents_discover",
            "nostr_projects",
            "delegate_phase", // PM uses delegate_phase instead of delegate
        ];
    }

    // Base tools for all other agents
    const tools = [
        readPathTool.name, 
        lessonLearnTool.name, 
        // analyze.name,
        claudeCode.name,
        completeTool.name,  // All agents can complete tasks
        delegateTool.name    // Non-PM agents use regular delegate
    ];

    return tools;
}
