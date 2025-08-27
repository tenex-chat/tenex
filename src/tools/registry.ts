/**
 * Tool Registry
 *
 * Central registry for all available tools in the TENEX system.
 * Tools are registered by name and can be retrieved individually
 * or in bulk for agent assignment.
 */

import { agentsDiscover } from "./implementations/agents-discover.js";
import { agentsHire } from "./implementations/agents-hire.js";
import { agentsList } from "./implementations/agents-list.js";
import { agentsRead } from "./implementations/agents-read.js";
import { agentsWrite } from "./implementations/agents-write.js";
import { analyze } from "./implementations/analyze.js";
import { delegateExternalTool } from "./implementations/delegate_external.js";
import { claudeCode } from "./implementations/claude_code.js";
import { createProjectTool } from "./implementations/create_project.js";
import { delegateTool } from "./implementations/delegate.js";
import { delegatePhaseTool } from "./implementations/delegate_phase.js";
import { generateInventoryTool } from "./implementations/generateInventory.js";
import { lessonLearnTool } from "./implementations/learn.js";
import { lessonGetTool } from "./implementations/lessonGet.js";
import { mcpDiscover } from "./implementations/mcp-discover.js";
import { nostrProjectsTool } from "./implementations/nostr-projects.js";
import { readPathTool } from "./implementations/readPath.js";
import { reportDeleteTool } from "./implementations/report-delete.js";
import { reportReadTool } from "./implementations/report-read.js";
import { reportWriteTool } from "./implementations/report-write.js";
import { reportsListTool } from "./implementations/reports-list.js";
import { shellTool } from "./implementations/shell.js";
import { writeContextFileTool } from "./implementations/writeContextFile.js";
import type { Tool } from "./types.js";

/**
 * Union type of all available tool names in the system.
 * This ensures type safety when referencing tools throughout the codebase.
 */
export type ToolName =
  | "read_path"
  | "write_context_file"
  | "analyze"
  | "generate_inventory"
  | "lesson_learn"
  | "lesson_get"
  | "shell"
  | "agents_discover"
  | "agents_hire"
  | "agents_list"
  | "agents_read"
  | "agents_write"
  | "discover_capabilities"
  | "delegate"
  | "delegate_phase"
  | "nostr_projects"
  | "claude_code"
  | "create_project"
  | "delegate_external"
  | "report_write"
  | "report_read"
  | "reports_list"
  | "report_delete";

/**
 * Registry of all available tools mapped by their canonical names.
 * Tool names serve as unique identifiers for tool lookup and execution.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolsMap = new Map<ToolName, Tool<any, any>>([
  ["read_path", readPathTool],
  ["write_context_file", writeContextFileTool],
  ["analyze", analyze],
  ["generate_inventory", generateInventoryTool],
  ["lesson_learn", lessonLearnTool],
  ["lesson_get", lessonGetTool],
  ["shell", shellTool],
  ["agents_discover", agentsDiscover],
  ["agents_hire", agentsHire],
  ["agents_list", agentsList],
  ["agents_read", agentsRead],
  ["agents_write", agentsWrite],
  ["discover_capabilities", mcpDiscover],
  ["delegate", delegateTool],
  ["delegate_phase", delegatePhaseTool],
  ["nostr_projects", nostrProjectsTool],
  ["claude_code", claudeCode],
  ["create_project", createProjectTool],
  ["delegate_external", delegateExternalTool],
  ["report_write", reportWriteTool],
  ["report_read", reportReadTool],
  ["reports_list", reportsListTool],
  ["report_delete", reportDeleteTool],
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
