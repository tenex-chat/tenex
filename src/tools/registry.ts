import { analyze } from "./implementations/analyze";
import { generateInventoryTool } from "./implementations/generateInventory";
import { lessonLearnTool } from "./implementations/learn";
import { lessonGetTool } from "./implementations/lessonGet";
import { readPathTool } from "./implementations/readPath";
import { writeContextFileTool } from "./implementations/writeContextFile";
import { completeTool } from "./implementations/complete";
import { shellTool } from "./implementations/shell";
import { agentsDiscover } from "./implementations/agents-discover";
import { agentsHire } from "./implementations/agents-hire";
import { mcpDiscover } from "./implementations/mcp-discover";
import { delegateTool } from "./implementations/delegate";
import type { Tool } from "./types";

// Registry of all available tools
const toolsMap = new Map<string, Tool<any, any>>([
  ["read_path", readPathTool],
  ["write_context_file", writeContextFileTool],
  ["complete", completeTool],
  ["analyze", analyze],
  ["generate_inventory", generateInventoryTool],
  ["lesson_learn", lessonLearnTool],
  ["lesson_get", lessonGetTool],
  ["shell", shellTool],
  ["agents_discover", agentsDiscover],
  ["agents_hire", agentsHire],
  ["discover_capabilities", mcpDiscover],
  ["delegate", delegateTool],
]);

export function getTool(name: string): Tool<any, any> | undefined {
    return toolsMap.get(name);
}

export function getTools(names: string[]): Tool<any, any>[] {
    return names
        .map((name) => toolsMap.get(name))
        .filter((tool): tool is Tool<any, any> => tool !== undefined);
}

export function getAllTools(): Tool<any, any>[] {
    return Array.from(toolsMap.values());
}
