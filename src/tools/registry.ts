/**
 * Tool Registry - AI SDK Tools
 * 
 * Central registry for all AI SDK tools in the TENEX system.
 */

import type { ExecutionContext } from "@/agents/execution/types";
import { createReadPathTool } from "./implementations/readPath";
import { createWriteContextFileTool } from "./implementations/writeContextFile";
import { createGenerateInventoryTool } from "./implementations/generateInventory";
import { createLessonLearnTool } from "./implementations/learn";
import { createLessonGetTool } from "./implementations/lessonGet";
import { createShellTool } from "./implementations/shell";
import { createAgentsDiscoverTool } from "./implementations/agents-discover";
import { createAgentsHireTool } from "./implementations/agents-hire";
import { createAgentsListTool } from "./implementations/agents-list";
import { createAgentsReadTool } from "./implementations/agents-read";
import { createAgentsWriteTool } from "./implementations/agents-write";
import { createMcpDiscoverTool } from "./implementations/mcp-discover";
import { createDelegateTool } from "./implementations/delegate";
import { createDelegatePhaseTool } from "./implementations/delegate_phase";
import { createNostrProjectsTool } from "./implementations/nostr-projects";
import { createClaudeCodeTool } from "./implementations/claude_code";
import { createCreateProjectTool } from "./implementations/create_project";
import { createDelegateExternalTool } from "./implementations/delegate_external";
import { createReportWriteTool } from "./implementations/report-write";
import { createReportReadTool } from "./implementations/report-read";
import { createReportsListTool } from "./implementations/reports-list";
import { createReportDeleteTool } from "./implementations/report-delete";

/**
 * Tool names available in the system
 */
export type ToolName =
  | "read_path"
  | "write_context_file"
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
 * Tool factory type - functions that create AI SDK tools with context
 */
export type ToolFactory = (context: ExecutionContext) => any;

/**
 * Registry of tool factories
 */
const toolFactories: Record<ToolName, ToolFactory> = {
  read_path: createReadPathTool,
  write_context_file: createWriteContextFileTool,
  generate_inventory: createGenerateInventoryTool,
  lesson_learn: createLessonLearnTool,
  lesson_get: createLessonGetTool,
  shell: createShellTool,
  agents_discover: createAgentsDiscoverTool,
  agents_hire: createAgentsHireTool,
  agents_list: createAgentsListTool,
  agents_read: createAgentsReadTool,
  agents_write: createAgentsWriteTool,
  discover_capabilities: createMcpDiscoverTool,
  delegate: createDelegateTool,
  delegate_phase: createDelegatePhaseTool,
  nostr_projects: createNostrProjectsTool,
  claude_code: createClaudeCodeTool,
  create_project: createCreateProjectTool,
  delegate_external: createDelegateExternalTool,
  report_write: createReportWriteTool,
  report_read: createReportReadTool,
  reports_list: createReportsListTool,
  report_delete: createReportDeleteTool,
};

/**
 * Get a single tool by name
 * @param name - The tool name
 * @param context - Execution context for the tool
 * @returns The instantiated tool or undefined if not found
 */
export function getTool(name: ToolName, context: ExecutionContext): any {
  const factory = toolFactories[name];
  return factory ? factory(context) : undefined;
}

/**
 * Get multiple tools by name
 * @param names - Array of tool names
 * @param context - Execution context for the tools
 * @returns Array of instantiated tools
 */
export function getTools(names: ToolName[], context: ExecutionContext): any[] {
  return names
    .map(name => getTool(name, context))
    .filter(tool => tool !== undefined);
}

/**
 * Get all available tools
 * @param context - Execution context for the tools
 * @returns Array of all instantiated tools
 */
export function getAllTools(context: ExecutionContext): any[] {
  return Object.keys(toolFactories).map(name => 
    getTool(name as ToolName, context)
  );
}

/**
 * Get tools as a keyed object (for AI SDK usage)
 * @param names - Tool names to include
 * @param context - Execution context for the tools
 * @returns Object with tools keyed by name
 */
export function getToolsObject(names: ToolName[], context: ExecutionContext): Record<string, any> {
  const tools: Record<string, any> = {};
  
  for (const name of names) {
    const tool = getTool(name, context);
    if (tool) {
      tools[name] = tool;
    }
  }
  
  return tools;
}

/**
 * Get all tools as a keyed object
 * @param context - Execution context for the tools
 * @returns Object with all tools keyed by name
 */
export function getAllToolsObject(context: ExecutionContext): Record<string, any> {
  const tools: Record<string, any> = {};
  
  for (const name of Object.keys(toolFactories) as ToolName[]) {
    tools[name] = getTool(name, context);
  }
  
  return tools;
}

// Legacy exports for backward compatibility (will be removed later)
export const aiSdkToolFactories = toolFactories;
export const getAiSdkTools = getToolsObject;
export const getAllAiSdkTools = getAllToolsObject;