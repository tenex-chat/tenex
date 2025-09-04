/**
 * Tool Registry - AI SDK Tools
 * 
 * Central registry for all AI SDK tools in the TENEX system.
 */

import type { Tool as CoreTool } from "ai";
import type { ExecutionContext } from "@/agents/execution/types";
import { createReadPathTool } from "./implementations/read_path";
import { createWriteContextFileTool } from "./implementations/write_context_file";
import { createGenerateInventoryTool } from "./implementations/generate_inventory";
import { createLessonLearnTool } from "./implementations/learn";
import { createLessonGetTool } from "./implementations/lesson_get";
import { createShellTool } from "./implementations/shell";
import { createAgentsDiscoverTool } from "./implementations/agents_discover";
import { createAgentsHireTool } from "./implementations/agents_hire";
import { createAgentsListTool } from "./implementations/agents_list";
import { createAgentsReadTool } from "./implementations/agents_read";
import { createAgentsWriteTool } from "./implementations/agents_write";
import { createMcpDiscoverTool } from "./implementations/mcp_discover";
import { createDelegateTool } from "./implementations/delegate";
import { createDelegatePhaseTool } from "./implementations/delegate_phase";
import { createNostrProjectsTool } from "./implementations/nostr_projects";
import { createClaudeCodeTool } from "./implementations/claude_code";
import { createCreateProjectTool } from "./implementations/create_project";
import { createDelegateExternalTool } from "./implementations/delegate_external";
import { createReportWriteTool } from "./implementations/report_write";
import { createReportReadTool } from "./implementations/report_read";
import { createReportsListTool } from "./implementations/reports_list";
import { createReportDeleteTool } from "./implementations/report_delete";

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
 * AI SDK Tool type - this is what the tool() function returns
 * CoreTool includes the description and parameters properties we need
 */
export type AISdkTool = CoreTool<any, any>;

/**
 * Tool factory type - functions that create AI SDK tools with context
 */
export type ToolFactory = (context: ExecutionContext) => AISdkTool;

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
 * @returns The instantiated AI SDK tool or undefined if not found
 */
export function getTool(name: ToolName, context: ExecutionContext): AISdkTool | undefined {
  const factory = toolFactories[name];
  return factory ? factory(context) : undefined;
}

/**
 * Get multiple tools by name
 * @param names - Array of tool names
 * @param context - Execution context for the tools
 * @returns Array of instantiated AI SDK tools
 */
export function getTools(names: ToolName[], context: ExecutionContext): AISdkTool[] {
  return names
    .map(name => getTool(name, context))
    .filter((tool): tool is AISdkTool => tool !== undefined);
}

/**
 * Get all available tools
 * @param context - Execution context for the tools
 * @returns Array of all instantiated AI SDK tools
 */
export function getAllTools(context: ExecutionContext): AISdkTool[] {
  return Object.keys(toolFactories).map(name => 
    getTool(name as ToolName, context)
  ).filter((tool): tool is AISdkTool => tool !== undefined);
}

/**
 * Get all available tool names
 * @returns Array of all tool names in the registry
 */
export function getAllToolNames(): ToolName[] {
  return Object.keys(toolFactories) as ToolName[];
}

/**
 * Get tools as a keyed object (for AI SDK usage)
 * @param names - Tool names to include (can include MCP tool names)
 * @param context - Execution context for the tools
 * @returns Object with tools keyed by name
 */
export function getToolsObject(names: string[], context: ExecutionContext): Record<string, AISdkTool> {
  const tools: Record<string, AISdkTool> = {};
  
  // Separate MCP tools from regular tools
  const regularTools: ToolName[] = [];
  const mcpToolNames: string[] = [];
  
  for (const name of names) {
    if (name.startsWith('mcp__')) {
      mcpToolNames.push(name);
    } else if (name in toolFactories) {
      regularTools.push(name as ToolName);
    }
  }
  
  // Add regular tools
  for (const name of regularTools) {
    const tool = getTool(name, context);
    if (tool) {
      tools[name] = tool;
    }
  }
  
  // Add MCP tools if any requested
  if (mcpToolNames.length > 0) {
    try {
      // Import and get MCP tools dynamically
      const { mcpService } = require("@/services/mcp/MCPManager");
      const allMcpTools = mcpService.getCachedTools();
      
      for (const mcpToolName of mcpToolNames) {
        const mcpTool = allMcpTools.find(t => t.name === mcpToolName);
        if (mcpTool) {
          // Convert MCP tool to AI SDK format
          tools[mcpToolName] = {
            description: mcpTool.description || mcpToolName,
            parameters: mcpTool.parameters || {},
            execute: mcpTool.execute,
          } as AISdkTool;
        }
      }
    } catch (error) {
      // MCP not available, continue without MCP tools
      console.debug("Could not load MCP tools:", error);
    }
  }
  
  return tools;
}

/**
 * Get all tools as a keyed object
 * @param context - Execution context for the tools
 * @returns Object with all tools keyed by name
 */
export function getAllToolsObject(context: ExecutionContext): Record<string, AISdkTool> {
  const tools: Record<string, AISdkTool> = {};
  
  for (const name of Object.keys(toolFactories) as ToolName[]) {
    const tool = getTool(name, context);
    if (tool) {
      tools[name] = tool;
    }
  }
  
  return tools;
}

/**
 * Check if a tool name is valid
 * @param name - The tool name to check
 * @returns True if the tool name is valid
 */
export function isValidToolName(name: string): name is ToolName {
  return name in toolFactories;
}


