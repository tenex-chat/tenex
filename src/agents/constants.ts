import type { Agent } from "./types";
import { analyze } from "../tools/implementations/analyze";
import { continueTool } from "../tools/implementations/continue";
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
            // Orchestrator with routing backend doesn't need any tools
            if (agent.backend === "routing") {
                tools = [];
            } else {
                // Legacy orchestrator with reason-act-loop gets continue tool
                tools = [continueTool.name];
            }
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
