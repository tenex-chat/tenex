/**
 * Tool Registry - AI SDK Tools
 * 
 * Central registry for all AI SDK tools in the TENEX system.
 */

import type { Tool as CoreTool } from "ai";
import type { ExecutionContext } from "@/agents/execution/types";
import { dynamicToolService } from "@/services/DynamicToolService";
import { mcpService } from "@/services/mcp/MCPManager";
import { createReadPathTool } from "./implementations/read_path";
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
import { createDelegateFollowupTool } from "./implementations/delegate_followup";
import { createNostrProjectsTool } from "./implementations/nostr_projects";
import { createClaudeCodeTool } from "./implementations/claude_code";
import { createCreateProjectTool } from "./implementations/create_project";
import { createDelegateExternalTool } from "./implementations/delegate_external";
import { createReportWriteTool } from "./implementations/report_write";
import { createReportReadTool } from "./implementations/report_read";
import { createReportsListTool } from "./implementations/reports_list";
import { createReportDeleteTool } from "./implementations/report_delete";
import { createAddPhaseTool } from "./implementations/add_phase";
import { createRemovePhaseTool } from "./implementations/phase_remove";
import { createScheduleTaskTool } from "./implementations/schedule_task";
import { createListScheduledTasksTool } from "./implementations/schedule_tasks_list";
import { createCancelScheduledTaskTool } from "./implementations/schedule_task_cancel";
import { createCreateDynamicToolTool } from "./implementations/create_dynamic_tool";
import { createAskTool } from "./implementations/ask";
import { createUploadBlobTool } from "./implementations/upload_blob";
import { createCodebaseSearchTool } from "./implementations/codebase_search";
import { createRAGCreateCollectionTool } from "./implementations/rag_create_collection";
import { createRAGAddDocumentsTool } from "./implementations/rag_add_documents";
import { createRAGQueryTool } from "./implementations/rag_query";
import { createRAGDeleteCollectionTool } from "./implementations/rag_delete_collection";
import { createRAGListCollectionsTool } from "./implementations/rag_list_collections";
import { createRAGSubscriptionCreateTool } from "./implementations/rag_subscription_create";
import { createRAGSubscriptionListTool } from "./implementations/rag_subscription_list";
import { createRAGSubscriptionGetTool } from "./implementations/rag_subscription_get";
import { createRAGSubscriptionDeleteTool } from "./implementations/rag_subscription_delete";

/**
 * Tool names available in the system
 */
export type ToolName =
  | "read_path"
  | "codebase_search"
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
  | "delegate_followup"
  | "ask"
  | "nostr_projects"
  | "claude_code"
  | "create_project"
  | "delegate_external"
  | "report_write"
  | "report_read"
  | "reports_list"
  | "report_delete"
  | "phase_add"
  | "phase_remove"
  | "schedule_task"
  | "schedule_tasks_list"
  | "schedule_task_cancel"
  | "create_dynamic_tool"
  | "upload_blob"
  | "rag_create_collection"
  | "rag_add_documents"
  | "rag_query"
  | "rag_delete_collection"
  | "rag_list_collections"
  | "rag_subscription_create"
  | "rag_subscription_list"
  | "rag_subscription_get"
  | "rag_subscription_delete";

/**
 * AI SDK Tool type - tools with optional human-readable content generation
 * The getHumanReadableContent function is attached as a non-enumerable property
 */
export type AISdkTool<
  TInput = unknown,
  TOutput = unknown
> = CoreTool<TInput, TOutput> & {
  getHumanReadableContent?: (args: TInput) => string;
};

/**
 * Tool factory type - functions that create AI SDK tools with context
 */
export type ToolFactory = (context: ExecutionContext) => AISdkTool<unknown, unknown>;

/**
 * Registry of tool factories
 */
const toolFactories: Record<ToolName, ToolFactory> = {
  // Agent tools
  agents_discover: createAgentsDiscoverTool,
  agents_hire: createAgentsHireTool,
  agents_list: createAgentsListTool,
  agents_read: createAgentsReadTool,
  agents_write: createAgentsWriteTool,
  
  // Ask tool
  ask: createAskTool,

  // Claude code
  claude_code: createClaudeCodeTool,
  
  // Codebase search
  codebase_search: createCodebaseSearchTool,

  // Project tools
  create_project: createCreateProjectTool,
  nostr_projects: createNostrProjectsTool,

  // Delegation tools
  delegate_external: createDelegateExternalTool,
  delegate_followup: createDelegateFollowupTool,
  delegate_phase: createDelegatePhaseTool,
  delegate: createDelegateTool,

  discover_capabilities: createMcpDiscoverTool,

  // Lesson tools
  lesson_get: createLessonGetTool,
  lesson_learn: createLessonLearnTool,

  // Phase management tools
  phase_add: createAddPhaseTool,
  phase_remove: createRemovePhaseTool,

  read_path: createReadPathTool,

  // Report tools
  report_delete: createReportDeleteTool,
  report_read: createReportReadTool,
  report_write: createReportWriteTool,
  reports_list: createReportsListTool,

  // Schedule tools
  schedule_task_cancel: createCancelScheduledTaskTool,
  schedule_task: createScheduleTaskTool,
  schedule_tasks_list: createListScheduledTasksTool,
  
  shell: createShellTool,
  
  // Dynamic tool creation
  create_dynamic_tool: createCreateDynamicToolTool,
  
  // Upload tools
  upload_blob: createUploadBlobTool,
  
  // RAG tools
  rag_create_collection: createRAGCreateCollectionTool,
  rag_add_documents: createRAGAddDocumentsTool,
  rag_query: createRAGQueryTool,
  rag_delete_collection: createRAGDeleteCollectionTool,
  rag_list_collections: createRAGListCollectionsTool,
  
  // RAG subscription tools
  rag_subscription_create: createRAGSubscriptionCreateTool,
  rag_subscription_list: createRAGSubscriptionListTool,
  rag_subscription_get: createRAGSubscriptionGetTool,
  rag_subscription_delete: createRAGSubscriptionDeleteTool,
};

/**
 * Get a single tool by name
 * @param name - The tool name
 * @param context - Execution context for the tool
 * @returns The instantiated AI SDK tool or undefined if not found
 */
export function getTool(name: ToolName, context: ExecutionContext): AISdkTool<unknown, unknown> | undefined {
  const factory = toolFactories[name];
  const ret = factory ? factory(context) : undefined;
  return ret;
}

/**
 * Get multiple tools by name
 * @param names - Array of tool names
 * @param context - Execution context for the tools
 * @returns Array of instantiated AI SDK tools
 */
export function getTools(names: ToolName[], context: ExecutionContext): AISdkTool<unknown, unknown>[] {
  return names
    .map(name => getTool(name, context))
    .filter((tool): tool is AISdkTool<unknown, unknown> => tool !== undefined);
}

/**
 * Get all available tools
 * @param context - Execution context for the tools
 * @returns Array of all instantiated AI SDK tools
 */
export function getAllTools(context: ExecutionContext): AISdkTool<unknown, unknown>[] {
  const toolNames = Object.keys(toolFactories) as ToolName[];
  return toolNames.map(name =>
    getTool(name, context)
  ).filter((tool): tool is AISdkTool<unknown, unknown> => !!tool);
}

/**
 * Get all available tool names
 * @returns Array of all tool names in the registry
 */
export function getAllToolNames(): ToolName[] {
  return Object.keys(toolFactories);
}

/**
 * Get tools as a keyed object (for AI SDK usage)
 * @param names - Tool names to include (can include MCP tool names and dynamic tool names)
 * @param context - Execution context for the tools
 * @returns Object with tools keyed by name (returns the underlying CoreTool)
 */
export function getToolsObject(names: string[], context: ExecutionContext): Record<string, CoreTool<unknown, unknown>> {
  const tools: Record<string, CoreTool<unknown, unknown>> = {};

  // Separate MCP tools, dynamic tools, and regular tools
  const regularTools: ToolName[] = [];
  const mcpToolNames: string[] = [];
  const dynamicToolNames: string[] = [];

  for (const name of names) {
    if (name.startsWith('mcp__')) {
      mcpToolNames.push(name);
    } else if (name in toolFactories) {
      regularTools.push(name as ToolName);
    } else if (dynamicToolService.isDynamicTool(name)) {
      dynamicToolNames.push(name);
    }
  }

  // Add regular tools
  for (const name of regularTools) {
    const tool = getTool(name, context);
    if (tool) {
      // Tools are now CoreTool instances with getHumanReadableContent as non-enumerable property
      tools[name] = tool;
    }
  }

  // Add dynamic tools
  if (dynamicToolNames.length > 0) {
    const dynamicTools = dynamicToolService.getDynamicToolsObject(context);
    for (const name of dynamicToolNames) {
      if (dynamicTools[name]) {
        tools[name] = dynamicTools[name];
      } else {
        console.debug(`Dynamic tool '${name}' not found`);
      }
    }
  }

  // Add MCP tools if any requested
  if (mcpToolNames.length > 0) {
    try {
      // Get MCP tools from service
      const allMcpTools = mcpService.getCachedTools();

      for (const mcpToolName of mcpToolNames) {
        // getCachedTools returns an object keyed by tool name
        const mcpTool = allMcpTools[mcpToolName];
        if (mcpTool) {
          // MCP tools from AI SDK already have the correct structure
          // They are CoreTool instances with description, parameters, and execute
          tools[mcpToolName] = mcpTool;
        } else {
          console.debug(`MCP tool '${mcpToolName}' not found in cached tools`);
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
 * @returns Object with all tools keyed by name (returns the underlying CoreTool)
 */
export function getAllToolsObject(context: ExecutionContext): Record<string, CoreTool<unknown, unknown>> {
  const tools: Record<string, CoreTool<unknown, unknown>> = {};

  // Add static tools
  const toolNames = Object.keys(toolFactories) as ToolName[];
  for (const name of toolNames) {
    const tool = getTool(name, context);
    if (tool) {
      // Tools are now CoreTool instances with getHumanReadableContent as non-enumerable property
      tools[name] = tool;
    }
  }

  // Add dynamic tools
  const dynamicTools = dynamicToolService.getDynamicToolsObject(context);
  Object.assign(tools, dynamicTools);

  return tools;
}

/**
 * Check if a tool name is valid
 * @param name - The tool name to check
 * @returns True if the tool name is valid
 */
export function isValidToolName(name: string): boolean {
  return name in toolFactories || dynamicToolService.isDynamicTool(name);
}

/**
 * Get all available tool names including dynamic tools
 * @returns Array of all tool names (static and dynamic)
 */
export function getAllAvailableToolNames(): string[] {
  const staticTools = getAllToolNames();
  const dynamicTools = Array.from(dynamicToolService.getDynamicTools().keys());
  return [...staticTools, ...dynamicTools];
}


