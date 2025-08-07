import { analyze } from "./implementations/analyze";
import { continueTool } from "./implementations/continue";
import { createMilestoneTaskTool } from "./implementations/createMilestoneTask";
import { endConversationTool } from "./implementations/endConversation";
import { generateInventoryTool } from "./implementations/generateInventory";
import { learnTool } from "./implementations/learn";
import { readPathTool } from "./implementations/readPath";
import { writeContextFileTool } from "./implementations/writeContextFile";
import { completeTool } from "./implementations/complete";
import { shellTool } from "./implementations/shell";
import type { Tool } from "./types";

// Registry of all available tools
const toolsMap = new Map<string, Tool>([
    ["read_path", readPathTool],
    ["write_context_file", writeContextFileTool],
    ["continue", continueTool],
    ["complete", completeTool],
    ["end_conversation", endConversationTool],
    ["analyze", analyze],
    ["generate_inventory", generateInventoryTool],
    ["learn", learnTool],
    ["create_milestone_task", createMilestoneTaskTool],
    ["shell", shellTool],
]);

export function getTool(name: string): Tool | undefined {
    return toolsMap.get(name);
}

export function getTools(names: string[]): Tool[] {
    return names
        .map((name) => toolsMap.get(name))
        .filter((tool): tool is Tool => tool !== undefined);
}

export function getAllTools(): Tool[] {
    return Array.from(toolsMap.values());
}
