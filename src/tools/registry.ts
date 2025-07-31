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
const toolsMap = new Map<string, Tool<unknown, unknown>>();
toolsMap.set("read_path", readPathTool as Tool<unknown, unknown>);
toolsMap.set("write_context_file", writeContextFileTool as Tool<unknown, unknown>);
toolsMap.set("continue", continueTool as Tool<unknown, unknown>);
toolsMap.set("complete", completeTool as Tool<unknown, unknown>);
toolsMap.set("end_conversation", endConversationTool as Tool<unknown, unknown>);
toolsMap.set("analyze", analyze as Tool<unknown, unknown>);
toolsMap.set("generate_inventory", generateInventoryTool as Tool<unknown, unknown>);
toolsMap.set("learn", learnTool as Tool<unknown, unknown>);
toolsMap.set("create_milestone_task", createMilestoneTaskTool as Tool<unknown, unknown>);
toolsMap.set("shell", shellTool as Tool<unknown, unknown>);

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
