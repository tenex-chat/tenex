import type { Agent } from "./types";
import { analyze } from "../tools/implementations/analyze";
import { generateInventoryTool } from "../tools/implementations/generateInventory";
import { learnTool } from "../tools/implementations/learn";
import { readPathTool } from "../tools/implementations/readPath";
import { writeContextFileTool } from "@/tools/implementations/writeContextFile";
import { completeTool } from "../tools/implementations/complete";
import { shellTool } from "../tools/implementations/shell";

// Agent slug constants
export const PROJECT_MANAGER_AGENT = "project-manager" as const;

/**
 * Get all available tools for an agent based on their role
 * All agents now have access to all tools except orchestrator-only tools
 */
export function getDefaultToolsForAgent(agent: Agent): string[] {
    let tools = [readPathTool.name, learnTool.name, analyze.name];

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
                tools.push(generateInventoryTool.name);
                tools.push(writeContextFileTool.name);
                tools.push(shellTool.name);
            }
        }
    } else {
        // Custom agents default to complete tool
        tools.push(completeTool.name);
    }

    return tools;
}
