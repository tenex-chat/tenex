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
  | "read-path"
  | "write-context-file"
  | "analyze"
  | "generate-inventory"
  | "lesson-learn"
  | "lesson-get"
  | "shell"
  | "agents-discover"
  | "agents-hire"
  | "agents-list"
  | "agents-read"
  | "agents-write"
  | "discover-capabilities"
  | "delegate"
  | "delegate-phase"
  | "nostr-projects"
  | "claude-code"
  | "create-project"
  | "delegate-external"
  | "report-write"
  | "report-read"
  | "reports-list"
  | "report-delete";

/**
 * Registry of all available tools mapped by their canonical names.
 * Tool names serve as unique identifiers for tool lookup and execution.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolsMap = new Map<ToolName, Tool<any, any>>([
  ["read-path", readPathTool],
  ["write-context-file", writeContextFileTool],
  ["analyze", analyze],
  ["generate-inventory", generateInventoryTool],
  ["lesson-learn", lessonLearnTool],
  ["lesson-get", lessonGetTool],
  ["shell", shellTool],
  ["agents-discover", agentsDiscover],
  ["agents-hire", agentsHire],
  ["agents-list", agentsList],
  ["agents-read", agentsRead],
  ["agents-write", agentsWrite],
  ["discover-capabilities", mcpDiscover],
  ["delegate", delegateTool],
  ["delegate-phase", delegatePhaseTool],
  ["nostr-projects", nostrProjectsTool],
  ["claude-code", claudeCode],
  ["create-project", createProjectTool],
  ["delegate-external", delegateExternalTool],
  ["report-write", reportWriteTool],
  ["report-read", reportReadTool],
  ["reports-list", reportsListTool],
  ["report-delete", reportDeleteTool],
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
