/**
 * Tool Registry
 * 
 * Central registry for all available tools in the TENEX system.
 * Tools are registered by name and can be retrieved individually
 * or in bulk for agent assignment.
 */

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
import { nostrProjectsTool } from "./implementations/nostr-projects";
import { claudeCode } from "./implementations/claude_code";
import type { Tool } from "./types";

/**
 * Union type of all available tool names in the system.
 * This ensures type safety when referencing tools throughout the codebase.
 */
export type ToolName = 
  | "read_path"
  | "write_context_file"
  | "complete"
  | "analyze"
  | "generate_inventory"
  | "lesson_learn"
  | "lesson_get"
  | "shell"
  | "agents_discover"
  | "agents_hire"
  | "discover_capabilities"
  | "delegate"
  | "nostr_projects"
  | "claude_code";

/**
 * Registry of all available tools mapped by their canonical names.
 * Tool names serve as unique identifiers for tool lookup and execution.
 */
const toolsMap = new Map<ToolName, Tool<any, any>>([
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
  ["nostr_projects", nostrProjectsTool],
  ["claude_code", claudeCode],
]);

/**
 * Retrieve a single tool by name.
 * 
 * @param name - The canonical name of the tool to retrieve
 * @returns The tool instance if found, undefined otherwise
 */
export function getTool(name: ToolName): Tool<any, any> | undefined {
    return toolsMap.get(name);
}

/**
 * Retrieve multiple tools by their names.
 * Non-existent tools are silently filtered out.
 * 
 * @param names - Array of tool names to retrieve
 * @returns Array of found tools (may be shorter than input if some tools don't exist)
 */
export function getTools(names: ToolName[]): Tool<any, any>[] {
    return names
        .map((name) => toolsMap.get(name))
        .filter((tool): tool is Tool<any, any> => tool !== undefined);
}

/**
 * Get all registered tools in the system.
 * Useful for discovery and capability enumeration.
 * 
 * @returns Array of all registered tools
 */
export function getAllTools(): Tool<any, any>[] {
    return Array.from(toolsMap.values());
}
