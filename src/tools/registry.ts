/**
 * Tool Registry - AI SDK Tools
 *
 * Central registry for all AI SDK tools in the TENEX system.
 */

import { config as configService } from "@/services/ConfigService";
import { isMetaModelConfiguration } from "@/services/config/types";
import type { Tool as CoreTool } from "ai";
import type { AISdkTool, ToolExecutionContext, ToolFactory, ToolName, ToolRegistryContext, MCPToolContext } from "./types";

// Helper to coerce MCP tool types without triggering TypeScript infinite recursion
// The MCP SDK returns tools with compatible structure but different generic params
function asTool<T>(tool: T): CoreTool<unknown, unknown> {
    return tool as CoreTool<unknown, unknown>;
}
import { logger } from "@/utils/logger";
import { createAgentsPublishTool } from "./implementations/agents_publish";
import { createAgentsDiscoverTool } from "./implementations/agents_discover";
import { createAgentsHireTool } from "./implementations/agents_hire";
import { createAgentsListTool } from "./implementations/agents_list";
import { createAgentsReadTool } from "./implementations/agents_read";
import { createAgentsWriteTool } from "./implementations/agents_write";
import { createAskTool } from "./implementations/ask";
import { createConversationGetTool } from "./implementations/conversation_get";
import { createFsGlobTool } from "./implementations/fs_glob";
import { createFsGrepTool } from "./implementations/fs_grep";
import { createConversationListTool } from "./implementations/conversation_list";
import { createCreateProjectTool } from "./implementations/create_project";
import { createDelegateTool } from "./implementations/delegate";
import { createDelegateCrossProjectTool } from "./implementations/delegate_crossproject";
import { createDelegateFollowupTool } from "./implementations/delegate_followup";
import { createLessonLearnTool } from "./implementations/learn";
import { createLessonGetTool } from "./implementations/lesson_get";
import { createMcpDiscoverTool } from "./implementations/mcp_discover";
import { createProjectListTool } from "./implementations/project_list";
import { createRAGAddDocumentsTool } from "./implementations/rag_add_documents";
import { createRAGCreateCollectionTool } from "./implementations/rag_create_collection";
import { createRAGDeleteCollectionTool } from "./implementations/rag_delete_collection";
import { createRAGListCollectionsTool } from "./implementations/rag_list_collections";
import { createRAGQueryTool } from "./implementations/rag_query";
import { createRAGSubscriptionCreateTool } from "./implementations/rag_subscription_create";
import { createRAGSubscriptionDeleteTool } from "./implementations/rag_subscription_delete";
import { createRAGSubscriptionGetTool } from "./implementations/rag_subscription_get";
import { createRAGSubscriptionListTool } from "./implementations/rag_subscription_list";
import { createFsReadTool } from "./implementations/fs_read";
import { createReportDeleteTool } from "./implementations/report_delete";
import { createReportReadTool } from "./implementations/report_read";
import { createReportWriteTool } from "./implementations/report_write";
import { createReportsListTool } from "./implementations/reports_list";
import { createScheduleTaskTool } from "./implementations/schedule_task";
import { createCancelScheduledTaskTool } from "./implementations/schedule_task_cancel";
import { createListScheduledTasksTool } from "./implementations/schedule_tasks_list";
import { createConversationSearchTool } from "./implementations/conversation_search";
import { createShellTool } from "./implementations/shell";
import { createKillShellTool } from "./implementations/kill_shell";
import { createUploadBlobTool } from "./implementations/upload_blob";
import { createFsWriteTool } from "./implementations/fs_write";
import { createFsEditTool } from "./implementations/fs_edit";

// Alpha mode bug reporting tools
import { createBugListTool } from "./implementations/bug_list";
import { createBugReportAddTool } from "./implementations/bug_report_add";
import { createBugReportCreateTool } from "./implementations/bug_report_create";

// Todo tools
import { createTodoWriteTool } from "./implementations/todo";

// Web tools
import { createWebFetchTool } from "./implementations/web_fetch";
import { createWebSearchTool } from "./implementations/web_search";

// Nostr tools
import { createNostrFetchTool } from "./implementations/nostr_fetch";

// Meta model tools
import { createChangeModelTool } from "./implementations/change_model";

/**
 * Metadata about tools that doesn't require instantiation.
 * Tools declare hasSideEffects: false if they are read-only operations.
 * Default (not listed) = true (has side effects).
 */
const toolMetadata: Partial<Record<ToolName, { hasSideEffects: boolean }>> = {
    // Read-only tools - these don't modify any state
    fs_read: { hasSideEffects: false },
    fs_glob: { hasSideEffects: false },
    fs_grep: { hasSideEffects: false },
    conversation_get: { hasSideEffects: false },
    conversation_list: { hasSideEffects: false },
    conversation_search: { hasSideEffects: false },
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
    web_fetch: { hasSideEffects: false },
    web_search: { hasSideEffects: false },
    nostr_fetch: { hasSideEffects: false },
};

/**
 * Tools that require conversation context to function.
 * These are filtered out when no conversation is available (e.g., MCP context).
 */
const CONVERSATION_REQUIRED_TOOLS: Set<ToolName> = new Set([
    "todo_write",
    "conversation_get", // Needs conversation for current-conversation optimization
    "change_model", // Needs conversation to persist variant override
]);

/**
 * Registry of tool factories.
 * All tools receive ToolExecutionContext - tools that don't need
 * agentPublisher/ralNumber simply ignore those fields.
 */
const toolFactories: Record<ToolName, ToolFactory> = {
    // Agent tools
    agents_publish: createAgentsPublishTool,
    agents_discover: createAgentsDiscoverTool,
    agents_hire: createAgentsHireTool,
    agents_list: createAgentsListTool,
    agents_read: createAgentsReadTool,
    agents_write: createAgentsWriteTool,

    // Ask tool
    ask: createAskTool,

    // File search tools
    fs_glob: createFsGlobTool,
    fs_grep: createFsGrepTool,

    // Conversation tools
    conversation_get: createConversationGetTool,
    conversation_list: createConversationListTool,

    // Project tools
    create_project: createCreateProjectTool,
    project_list: createProjectListTool,

    // Delegation tools
    delegate_crossproject: createDelegateCrossProjectTool,
    delegate_followup: createDelegateFollowupTool,
    delegate: createDelegateTool,

    discover_capabilities: createMcpDiscoverTool,

    // Lesson tools
    lesson_get: createLessonGetTool,
    lesson_learn: createLessonLearnTool,

    fs_read: createFsReadTool,
    fs_write: createFsWriteTool,
    fs_edit: createFsEditTool,

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
    conversation_search: createConversationSearchTool,

    shell: createShellTool,
    kill_shell: createKillShellTool,

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

    // Todo tools - require ConversationToolContext (filtered out when no conversation)
    todo_write: createTodoWriteTool as ToolFactory,

    // Web tools
    web_fetch: createWebFetchTool,
    web_search: createWebSearchTool,

    // Nostr tools
    nostr_fetch: createNostrFetchTool,

    // Meta model tools - requires ConversationToolContext (filtered out when no conversation)
    change_model: createChangeModelTool as ToolFactory,
};

/**
 * Get a single tool by name
 * @param name - The tool name
 * @param context - Tool execution context
 * @returns The instantiated AI SDK tool or undefined if not found
 */
export function getTool(
    name: ToolName,
    context: ToolExecutionContext
): AISdkTool<unknown, unknown> | undefined {
    const factory = toolFactories[name];
    const ret = factory ? factory(context) : undefined;
    return ret;
}

/**
 * Get multiple tools by name
 * @param names - Array of tool names
 * @param context - Tool execution context
 * @returns Array of instantiated AI SDK tools
 */
export function getTools(
    names: ToolName[],
    context: ToolExecutionContext
): AISdkTool<unknown, unknown>[] {
    return names
        .map((name) => getTool(name, context))
        .filter((tool): tool is AISdkTool<unknown, unknown> => tool !== undefined);
}

/**
 * Get all available tools
 * @param context - Tool execution context
 * @returns Array of all instantiated AI SDK tools
 */
export function getAllTools(context: ToolExecutionContext): AISdkTool<unknown, unknown>[] {
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

/** File editing tools - auto-injected when fs_write is available */
const FILE_EDIT_TOOLS: ToolName[] = ["fs_edit"];

/** Todo tools - for restricted agent execution (reminder mode) */
const TODO_TOOLS: ToolName[] = ["todo_write"];

/** Meta model tools - auto-injected when agent uses a meta model configuration */
const META_MODEL_TOOLS: ToolName[] = ["change_model"];

/**
 * Get tools as a keyed object (for AI SDK usage)
 * @param names - Tool names to include (can include MCP tool names)
 * @param context - Registry context (full or MCP partial)
 * @returns Object with tools keyed by name (returns the underlying CoreTool)
 */
export function getToolsObject(
    names: string[],
    context: ToolRegistryContext | MCPToolContext
): Record<string, CoreTool<unknown, unknown>> {
    const tools: Record<string, CoreTool<unknown, unknown>> = {};

    // Check if conversation is available
    const hasConversation = 'conversationStore' in context && context.conversationStore !== undefined;

    // Separate regular tools and MCP tools
    const regularTools: ToolName[] = [];
    const mcpToolNames: string[] = [];

    for (const name of names) {
        if (name.startsWith("mcp__")) {
            mcpToolNames.push(name);
        } else if (name in toolFactories) {
            // Filter out conversation-required tools when no conversation available
            if (CONVERSATION_REQUIRED_TOOLS.has(name as ToolName) && !hasConversation) {
                logger.debug(`Filtering out tool '${name}' - requires conversation context`);
                continue;
            }
            regularTools.push(name as ToolName);
        }
    }

    // Auto-inject alpha tools when in alpha mode (only for full registry context)
    if ('alphaMode' in context && context.alphaMode) {
        for (const alphaToolName of ALPHA_TOOLS) {
            if (!regularTools.includes(alphaToolName)) {
                regularTools.push(alphaToolName);
            }
        }
    }

    // Auto-inject edit tool when fs_write is available
    if (regularTools.includes("fs_write")) {
        for (const editToolName of FILE_EDIT_TOOLS) {
            if (!regularTools.includes(editToolName)) {
                regularTools.push(editToolName);
            }
        }
    }

    // Auto-inject change_model tool when agent uses a meta model configuration
    // Only inject if we have conversation context (needed for variant override persistence)
    if (hasConversation && 'agent' in context && context.agent?.llmConfig) {
        try {
            const rawConfig = configService.getRawLLMConfig(context.agent.llmConfig);
            if (isMetaModelConfiguration(rawConfig)) {
                for (const metaToolName of META_MODEL_TOOLS) {
                    if (!regularTools.includes(metaToolName)) {
                        regularTools.push(metaToolName);
                    }
                }
            }
        } catch {
            // Config not loaded or not available - skip meta model tool injection
        }
    }

    // Add regular tools (cast to ToolExecutionContext - filtered tools won't need conversation)
    for (const name of regularTools) {
        const tool = getTool(name, context as ToolExecutionContext);
        if (tool) {
            // Tools are now CoreTool instances with getHumanReadableContent as non-enumerable property
            tools[name] = tool;
        }
    }

    // Add only requested MCP tools (only for full registry context)
    if (mcpToolNames.length > 0 && 'mcpManager' in context && context.mcpManager) {
        try {
            const allMcpTools = context.mcpManager.getCachedTools();
            for (const name of mcpToolNames) {
                if (allMcpTools[name]) {
                    tools[name] = asTool(allMcpTools[name]);
                }
            }
        } catch (error) {
            console.debug("Could not load MCP tools:", error);
        }
    }

    return tools;
}

/**
 * Get all tools as a keyed object
 * @param context - Tool execution context
 * @returns Object with all tools keyed by name (returns the underlying CoreTool)
 */
export function getAllToolsObject(
    context: ToolExecutionContext
): Record<string, CoreTool<unknown, unknown>> {
    const tools: Record<string, CoreTool<unknown, unknown>> = {};

    const toolNames = Object.keys(toolFactories) as ToolName[];
    for (const name of toolNames) {
        const tool = getTool(name, context);
        if (tool) {
            // Tools are now CoreTool instances with getHumanReadableContent as non-enumerable property
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
export function isValidToolName(name: string): boolean {
    return name in toolFactories;
}

/**
 * Get all available tool names
 * @returns Array of all tool names
 */
export function getAllAvailableToolNames(): string[] {
    return getAllToolNames();
}

/**
 * Check if a tool has side effects.
 * Returns true (has side effects) by default for unknown tools (safe default).
 * @param toolName - The tool name to check
 * @returns true if the tool has side effects, false if it's read-only
 */
export function toolHasSideEffects(toolName: string): boolean {
    if (toolName in toolMetadata) {
        return toolMetadata[toolName as ToolName]?.hasSideEffects !== false;
    }

    // MCP tools are assumed to have side effects by default
    // This is the safe default - assume side effects unless explicitly declared otherwise
    return true;
}

/**
 * Get the list of todo tool names.
 * Used for restricted agent execution in reminder mode.
 * @returns Array of todo tool names
 */
export function getTodoToolNames(): ToolName[] {
    return [...TODO_TOOLS];
}

/**
 * Get todo tools as a keyed object.
 * Used for creating restricted tool sets for reminder mode.
 * @param context - Tool execution context
 * @returns Object with todo tools keyed by name
 */
export function getTodoToolsObject(
    context: ToolExecutionContext
): Record<string, CoreTool<unknown, unknown>> {
    const tools: Record<string, CoreTool<unknown, unknown>> = {};

    for (const name of TODO_TOOLS) {
        const tool = getTool(name, context);
        if (tool) {
            tools[name] = tool;
        }
    }

    return tools;
}
