/**
 * Tool Registry - AI SDK Tools
 *
 * Central registry for all AI SDK tools in the TENEX system.
 */

import type { ExecutionContext } from "@/agents/execution/types";
import { dynamicToolService } from "@/services/DynamicToolService";
import { mcpService } from "@/services/mcp/MCPManager";
import type { Tool as CoreTool } from "ai";
import type { AISdkTool, ToolFactory, ToolName } from "./types";
import { createAddPhaseTool } from "./implementations/add_phase";
import { createAgentsDiscoverTool } from "./implementations/agents_discover";
import { createAgentsHireTool } from "./implementations/agents_hire";
import { createAgentsListTool } from "./implementations/agents_list";
import { createAgentsReadTool } from "./implementations/agents_read";
import { createAgentsWriteTool } from "./implementations/agents_write";
import { createAskTool } from "./implementations/ask";
import { createCodebaseSearchTool } from "./implementations/codebase_search";
import { createConversationGetTool } from "./implementations/conversation_get";
import { createConversationListTool } from "./implementations/conversation_list";
import { createCreateDynamicToolTool } from "./implementations/create_dynamic_tool";
import { createCreateProjectTool } from "./implementations/create_project";
import { createDelegateTool } from "./implementations/delegate";
import { createDelegateExternalTool } from "./implementations/delegate_external";
import { createDelegateFollowupTool } from "./implementations/delegate_followup";
import { createRalInjectTool } from "./implementations/ral_inject";
import { createRalAbortTool } from "./implementations/ral_abort";
import { createLessonLearnTool } from "./implementations/learn";
import { createLessonGetTool } from "./implementations/lesson_get";
import { createMcpDiscoverTool } from "./implementations/mcp_discover";
import { createProjectListTool } from "./implementations/project_list";
import { createRemovePhaseTool } from "./implementations/phase_remove";
import { createRAGAddDocumentsTool } from "./implementations/rag_add_documents";
import { createRAGCreateCollectionTool } from "./implementations/rag_create_collection";
import { createRAGDeleteCollectionTool } from "./implementations/rag_delete_collection";
import { createRAGListCollectionsTool } from "./implementations/rag_list_collections";
import { createRAGQueryTool } from "./implementations/rag_query";
import { createRAGSubscriptionCreateTool } from "./implementations/rag_subscription_create";
import { createRAGSubscriptionDeleteTool } from "./implementations/rag_subscription_delete";
import { createRAGSubscriptionGetTool } from "./implementations/rag_subscription_get";
import { createRAGSubscriptionListTool } from "./implementations/rag_subscription_list";
import { createReadPathTool } from "./implementations/read_path";
import { createReportDeleteTool } from "./implementations/report_delete";
import { createReportReadTool } from "./implementations/report_read";
import { createReportWriteTool } from "./implementations/report_write";
import { createReportsListTool } from "./implementations/reports_list";
import { createScheduleTaskTool } from "./implementations/schedule_task";
import { createCancelScheduledTaskTool } from "./implementations/schedule_task_cancel";
import { createListScheduledTasksTool } from "./implementations/schedule_tasks_list";
import { createSearchConversationsTool } from "./implementations/search_conversations";
import { createShellTool } from "./implementations/shell";
import { createUploadBlobTool } from "./implementations/upload_blob";
import { createWriteFileTool } from "./implementations/write_file";
import { createEditTool } from "./implementations/edit";

// Alpha mode bug reporting tools
import { createBugListTool } from "./implementations/bug_list";
import { createBugReportAddTool } from "./implementations/bug_report_add";
import { createBugReportCreateTool } from "./implementations/bug_report_create";

// Pairing tools
import { createStopPairingTool } from "./implementations/stop_pairing";

// Todo tools
import { createTodoAddTool, createTodoUpdateTool } from "./implementations/todo";

/**
 * Metadata about tools that doesn't require instantiation.
 * Tools declare hasSideEffects: false if they are read-only operations.
 * Default (not listed) = true (has side effects).
 */
const toolMetadata: Partial<Record<ToolName, { hasSideEffects: boolean }>> = {
    // Read-only tools - these don't modify any state
    read_path: { hasSideEffects: false },
    codebase_search: { hasSideEffects: false },
    conversation_get: { hasSideEffects: false },
    conversation_list: { hasSideEffects: false },
    search_conversations: { hasSideEffects: false },
    lesson_get: { hasSideEffects: false },
    agents_list: { hasSideEffects: false },
    agents_read: { hasSideEffects: false },
    agents_discover: { hasSideEffects: false },
    project_list: { hasSideEffects: false },
    reports_list: { hasSideEffects: false },
    report_read: { hasSideEffects: false },
    schedule_tasks_list: { hasSideEffects: false },
    rag_list_collections: { hasSideEffects: false },
    rag_query: { hasSideEffects: false },
    rag_subscription_list: { hasSideEffects: false },
    rag_subscription_get: { hasSideEffects: false },
    bug_list: { hasSideEffects: false },
    discover_capabilities: { hasSideEffects: false },
};

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

    // Codebase search
    codebase_search: createCodebaseSearchTool,

    // Conversation tools
    conversation_get: createConversationGetTool,
    conversation_list: createConversationListTool,

    // Project tools
    create_project: createCreateProjectTool,
    project_list: createProjectListTool,

    // Delegation tools
    delegate_external: createDelegateExternalTool,
    delegate_followup: createDelegateFollowupTool,
    delegate: createDelegateTool,

    // RAL management tools (for concurrent execution)
    ral_inject: createRalInjectTool,
    ral_abort: createRalAbortTool,

    discover_capabilities: createMcpDiscoverTool,

    // Lesson tools
    lesson_get: createLessonGetTool,
    lesson_learn: createLessonLearnTool,

    // Phase management tools
    phase_add: createAddPhaseTool,
    phase_remove: createRemovePhaseTool,

    read_path: createReadPathTool,
    write_file: createWriteFileTool,
    edit: createEditTool,

    // Report tools
    report_delete: createReportDeleteTool,
    report_read: createReportReadTool,
    report_write: createReportWriteTool,
    reports_list: createReportsListTool,

    // Schedule tools
    schedule_task_cancel: createCancelScheduledTaskTool,
    schedule_task: createScheduleTaskTool,
    schedule_tasks_list: createListScheduledTasksTool,

    // Conversation search
    search_conversations: createSearchConversationsTool,

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

    // Alpha mode bug reporting tools
    bug_list: createBugListTool,
    bug_report_create: createBugReportCreateTool,
    bug_report_add: createBugReportAddTool,

    // Pairing tools
    stop_pairing: createStopPairingTool,

    // Todo tools
    todo_add: createTodoAddTool,
    todo_update: createTodoUpdateTool,
};

/**
 * Get a single tool by name
 * @param name - The tool name
 * @param context - Execution context for the tool
 * @returns The instantiated AI SDK tool or undefined if not found
 */
export function getTool(
    name: ToolName,
    context: ExecutionContext
): AISdkTool<unknown, unknown> | undefined {
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
export function getTools(
    names: ToolName[],
    context: ExecutionContext
): AISdkTool<unknown, unknown>[] {
    return names
        .map((name) => getTool(name, context))
        .filter((tool): tool is AISdkTool<unknown, unknown> => tool !== undefined);
}

/**
 * Get all available tools
 * @param context - Execution context for the tools
 * @returns Array of all instantiated AI SDK tools
 */
export function getAllTools(context: ExecutionContext): AISdkTool<unknown, unknown>[] {
    const toolNames = Object.keys(toolFactories) as ToolName[];
    return toolNames
        .map((name) => getTool(name, context))
        .filter((tool): tool is AISdkTool<unknown, unknown> => !!tool);
}

/**
 * Get all available tool names
 * @returns Array of all tool names in the registry
 */
export function getAllToolNames(): ToolName[] {
    return Object.keys(toolFactories) as ToolName[];
}

/** Alpha mode bug reporting tools - auto-injected when alphaMode is true */
const ALPHA_TOOLS: ToolName[] = ["bug_list", "bug_report_create", "bug_report_add"];

/** RAL management tools - auto-injected when hasConcurrentRALs is true */
const CONCURRENT_RAL_TOOLS: ToolName[] = ["ral_inject", "ral_abort", "delegate_followup"];

/** Pairing tools - auto-injected when hasActivePairings is true */
const PAIRING_TOOLS: ToolName[] = ["stop_pairing"];

/** File editing tools - auto-injected when write_file is available */
const FILE_EDIT_TOOLS: ToolName[] = ["edit"];

/**
 * Get tools as a keyed object (for AI SDK usage)
 * @param names - Tool names to include (can include MCP tool names and dynamic tool names)
 * @param context - Execution context for the tools
 * @returns Object with tools keyed by name (returns the underlying CoreTool)
 */
export function getToolsObject(
    names: string[],
    context: ExecutionContext
): Record<string, CoreTool<unknown, unknown>> {
    const tools: Record<string, CoreTool<unknown, unknown>> = {};

    // Separate dynamic tools and regular tools (MCP tools are added automatically)
    const regularTools: ToolName[] = [];
    const dynamicToolNames: string[] = [];

    for (const name of names) {
        if (name.startsWith("mcp__")) {
            // Skip MCP tool names - we'll add all available MCP tools automatically
            continue;
        } else if (name in toolFactories) {
            regularTools.push(name as ToolName);
        } else if (dynamicToolService.isDynamicTool(name)) {
            dynamicToolNames.push(name);
        }
    }

    // Auto-inject alpha tools when in alpha mode
    if (context.alphaMode) {
        for (const alphaToolName of ALPHA_TOOLS) {
            if (!regularTools.includes(alphaToolName)) {
                regularTools.push(alphaToolName);
            }
        }
    }

    // Auto-inject RAL management tools when there are concurrent RALs
    if (context.hasConcurrentRALs) {
        for (const ralToolName of CONCURRENT_RAL_TOOLS) {
            if (!regularTools.includes(ralToolName)) {
                regularTools.push(ralToolName);
            }
        }
    }

    // Auto-inject pairing tools when there are active pairings
    if (context.hasActivePairings) {
        for (const pairingToolName of PAIRING_TOOLS) {
            if (!regularTools.includes(pairingToolName)) {
                regularTools.push(pairingToolName);
            }
        }
    }

    // Auto-inject edit tool when write_file is available
    if (regularTools.includes("write_file")) {
        for (const editToolName of FILE_EDIT_TOOLS) {
            if (!regularTools.includes(editToolName)) {
                regularTools.push(editToolName);
            }
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

    // Add all available MCP tools
    try {
        // Get all MCP tools from service
        const allMcpTools = mcpService.getCachedTools();

        // Add all MCP tools to the tools object
        Object.assign(tools, allMcpTools);
    } catch (error) {
        // MCP not available, continue without MCP tools
        console.debug("Could not load MCP tools:", error);
    }

    return tools;
}

/**
 * Get all tools as a keyed object
 * @param context - Execution context for the tools
 * @returns Object with all tools keyed by name (returns the underlying CoreTool)
 */
export function getAllToolsObject(
    context: ExecutionContext
): Record<string, CoreTool<unknown, unknown>> {
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

/**
 * Check if a tool has side effects.
 * Returns true (has side effects) by default for unknown tools (safe default).
 * @param toolName - The tool name to check
 * @returns true if the tool has side effects, false if it's read-only
 */
export function toolHasSideEffects(toolName: string): boolean {
    // Check static tools
    if (toolName in toolMetadata) {
        return toolMetadata[toolName as ToolName]?.hasSideEffects !== false;
    }

    // Dynamic tools and MCP tools are assumed to have side effects by default
    // This is the safe default - assume side effects unless explicitly declared otherwise
    return true;
}
