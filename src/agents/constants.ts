import type { AgentInstance } from "./types";
import { analyze } from "../tools/implementations/analyze";
import { lessonLearnTool } from "../tools/implementations/learn";
import { readPathTool } from "../tools/implementations/readPath";
import { completeTool } from "../tools/implementations/complete";
import { PROJECT_MANAGER_AGENT_DEFINITION } from "./built-in/project-manager";

// Agent slug constants
export const PROJECT_MANAGER_AGENT = "project-manager" as const;

/**
 * Get all available tools for an agent based on their role
 * All agents now have access to all tools except orchestrator-only tools
 */
export function getDefaultToolsForAgent(agent: AgentInstance): string[] {
    let tools = [readPathTool.name, lessonLearnTool.name, analyze.name];

    // Built-in agents
    if (agent.isBuiltIn) {
        if (agent.isOrchestrator) {
            // Orchestrator MUST use routing backend and doesn't need any tools
            // It responds with structured JSON, not tool calls
            tools = [];
        } else {
            // Other non-orchestrator agents use complete tool to signal task completion
            tools.push(completeTool.name);

            if (agent.slug === PROJECT_MANAGER_AGENT) {
                // Use the tools defined in the PROJECT_MANAGER_AGENT_DEFINITION
                // This ensures consistency between the definition and runtime
                if (PROJECT_MANAGER_AGENT_DEFINITION.tools) {
                    // Replace the default tools with the ones from the definition
                    // but keep the complete tool since it's added for all non-orchestrator agents
                    tools = [completeTool.name, ...PROJECT_MANAGER_AGENT_DEFINITION.tools];
                }
            }
        }
    } else {
        // Custom agents default to complete tool
        tools.push(completeTool.name);
    }

    return tools;
}
