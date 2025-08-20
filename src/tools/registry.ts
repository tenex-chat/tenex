/**
 * Tool Registry
 *
 * Central registry for all available tools in the TENEX system.
 * Tools are registered by name and can be retrieved individually
 * or in bulk for agent assignment.
 */

import { agentsDiscover } from "./implementations/agents-discover";
import { agentsHire } from "./implementations/agents-hire";
import { analyze } from "./implementations/analyze";
import { claudeCode } from "./implementations/claude_code";
import { completeTool } from "./implementations/complete";
import { delegateTool } from "./implementations/delegate";
import { delegatePhaseTool } from "./implementations/delegate_phase";
import { generateInventoryTool } from "./implementations/generateInventory";
import { lessonLearnTool } from "./implementations/learn";
import { lessonGetTool } from "./implementations/lessonGet";
import { mcpDiscover } from "./implementations/mcp-discover";
import { nostrProjectsTool } from "./implementations/nostr-projects";
import { readPathTool } from "./implementations/readPath";
import { shellTool } from "./implementations/shell";
import { writeContextFileTool } from "./implementations/writeContextFile";
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
  | "delegate_phase"
  | "nostr_projects"
  | "claude_code";

/**
 * Registry of all available tools mapped by their canonical names.
 * Tool names serve as unique identifiers for tool lookup and execution.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  ["delegate_phase", delegatePhaseTool],
  ["nostr_projects", nostrProjectsTool],
  ["claude_code", claudeCode],
]);

/**
 * Retrieve a single tool by name.
 *
 * @param name - The canonical name of the tool to retrieve
 * @returns The tool instance if found, undefined otherwise
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTools(names: ToolName[]): Tool<any, any>[] {
  return (
    names
      .map((name) => toolsMap.get(name))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((tool): tool is Tool<any, any> => tool !== undefined)
  );
}

/**
 * Get all registered tools in the system.
 * Useful for discovery and capability enumeration.
 *
 * @returns Array of all registered tools
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAllTools(): Tool<any, any>[] {
  return Array.from(toolsMap.values());
}
