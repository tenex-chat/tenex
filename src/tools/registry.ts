/**
 * Tool Registry - AI SDK Tools
 *
 * Central registry for all AI SDK tools in the TENEX system.
 */

import { config as configService } from "@/services/ConfigService";
import { isMetaModelConfiguration } from "@/services/config/types";
import type { NudgeToolPermissions } from "@/services/nudge";
import { isOnlyToolMode } from "@/services/nudge";
import type { Tool as CoreTool } from "ai";
import type {
    AISdkTool,
    ToolExecutionContext,
    ToolFactory,
    ToolName,
    ToolRegistryContext,
} from "./types";

// Helper to coerce MCP tool types without triggering TypeScript infinite recursion
// The MCP SDK returns tools with compatible structure but different generic params
function asTool<T>(tool: T): CoreTool<unknown, unknown> {
    return tool as CoreTool<unknown, unknown>;
}
import { logger } from "@/utils/logger";
import { CORE_AGENT_TOOLS } from "@/agents/constants";
import { createAgentsDiscoverTool } from "./implementations/agents_discover";
import { createAgentsHireTool } from "./implementations/agents_hire";
import { createAgentsListTool } from "./implementations/agents_list";
import { createAgentsPublishTool } from "./implementations/agents_publish";
import { createAgentsReadTool } from "./implementations/agents_read";
import { createAgentsWriteTool } from "./implementations/agents_write";
import { createAskTool } from "./implementations/ask";
import { createConversationGetTool } from "./implementations/conversation_get";
import { createConversationListTool } from "./implementations/conversation_list";
import { createConversationSearchTool } from "./implementations/conversation_search";
import { createDelegateTool } from "./implementations/delegate";
import { createDelegateCrossProjectTool } from "./implementations/delegate_crossproject";
import { createDelegateFollowupTool } from "./implementations/delegate_followup";
import { createFsEditTool } from "./implementations/fs_edit";
import { createFsGlobTool } from "./implementations/fs_glob";
import { createFsGrepTool } from "./implementations/fs_grep";
import { createFsReadTool } from "./implementations/fs_read";
import { createFsWriteTool } from "./implementations/fs_write";
import { createKillTool } from "./implementations/kill";
import { createLessonLearnTool } from "./implementations/learn";
import { createLessonDeleteTool } from "./implementations/lesson_delete";
import { createLessonGetTool } from "./implementations/lesson_get";
import { createLessonsListTool } from "./implementations/lessons_list";
import { createProjectListTool } from "./implementations/project_list";
import { createRAGAddDocumentsTool } from "./implementations/rag_add_documents";
import { createRAGCreateCollectionTool } from "./implementations/rag_create_collection";
import { createRAGDeleteCollectionTool } from "./implementations/rag_delete_collection";
import { createRAGListCollectionsTool } from "./implementations/rag_list_collections";

import { createRAGSubscriptionCreateTool } from "./implementations/rag_subscription_create";
import { createRAGSubscriptionDeleteTool } from "./implementations/rag_subscription_delete";
import { createRAGSubscriptionGetTool } from "./implementations/rag_subscription_get";
import { createRAGSubscriptionListTool } from "./implementations/rag_subscription_list";
import { createMcpResourceReadTool } from "./implementations/mcp_resource_read";
import { createMcpSubscribeTool } from "./implementations/mcp_subscribe";
import { createMcpSubscriptionStopTool } from "./implementations/mcp_subscription_stop";
import { McpSubscriptionService } from "@/services/mcp/McpSubscriptionService";
import { createReportDeleteTool } from "./implementations/report_delete";
import { createReportReadTool } from "./implementations/report_read";
import { createReportWriteTool } from "./implementations/report_write";
import { createReportsListTool } from "./implementations/reports_list";
import { createScheduleTaskTool } from "./implementations/schedule_task";
import { createCancelScheduledTaskTool } from "./implementations/schedule_task_cancel";
import { createScheduleTaskOnceTool } from "./implementations/schedule_task_once";
import { createListScheduledTasksTool } from "./implementations/schedule_tasks_list";
import { createShellTool } from "./implementations/shell";
import { createUploadBlobTool } from "./implementations/upload_blob";

// Todo tools
import { createTodoWriteTool } from "./implementations/todo";

// Web tools
import { createWebFetchTool } from "./implementations/web_fetch";
import { createWebSearchTool } from "./implementations/web_search";

// Nostr tools
import { createNostrFetchTool } from "./implementations/nostr_fetch";
import { createNostrPublishAsUserTool } from "./implementations/nostr_publish_as_user";

// Unified RAG search tool
import { createRAGSearchTool } from "./implementations/rag-search";

// Image generation tools
import { createGenerateImageTool } from "./implementations/generate_image";

// Meta model tools
import { createChangeModelTool } from "./implementations/change_model";

// Home-scoped filesystem tools
import {
    createHomeFsGrepTool,
    createHomeFsReadTool,
    createHomeFsWriteTool,
} from "./implementations/home_fs";

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
    home_fs_read: { hasSideEffects: false },
    home_fs_grep: { hasSideEffects: false },
    conversation_get: { hasSideEffects: false },
    conversation_list: { hasSideEffects: false },
    conversation_search: { hasSideEffects: false },
    lesson_get: { hasSideEffects: false },
    lessons_list: { hasSideEffects: false },
    agents_list: { hasSideEffects: false },
    agents_read: { hasSideEffects: false },
    agents_discover: { hasSideEffects: false },
    project_list: { hasSideEffects: false },
    reports_list: { hasSideEffects: false },
    report_read: { hasSideEffects: false },
    schedule_tasks_list: { hasSideEffects: false },
    rag_list_collections: { hasSideEffects: false },

    rag_subscription_list: { hasSideEffects: false },
    rag_subscription_get: { hasSideEffects: false },
    mcp_resource_read: { hasSideEffects: false },
    // mcp_subscribe and mcp_subscription_stop have side effects (not listed = true by default)
    web_fetch: { hasSideEffects: false },
    web_search: { hasSideEffects: false },
    nostr_fetch: { hasSideEffects: false },
    rag_search: { hasSideEffects: false },
};

/**
 * Tools that require conversation context to function.
 * These are filtered out when no conversation is available (e.g., MCP context).
 */
const CONVERSATION_REQUIRED_TOOLS: Set<ToolName> = new Set([
    "todo_write",
    "conversation_get", // Needs conversation for current-conversation optimization
    "change_model", // Needs conversation to persist variant override
    "mcp_subscribe", // Needs conversation to bind subscription to it
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
    project_list: createProjectListTool,

    // Delegation tools
    delegate_crossproject: createDelegateCrossProjectTool,
    delegate_followup: createDelegateFollowupTool,
    delegate: createDelegateTool,

    // Lesson tools
    lesson_delete: createLessonDeleteTool,
    lesson_get: createLessonGetTool,
    lesson_learn: createLessonLearnTool,
    lessons_list: createLessonsListTool,

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
    schedule_task_once: createScheduleTaskOnceTool,
    schedule_tasks_list: createListScheduledTasksTool,

    // Conversation search
    conversation_search: createConversationSearchTool,

    // Unified RAG search across all project knowledge
    rag_search: createRAGSearchTool,

    shell: createShellTool,
    kill: createKillTool,

    // Upload tools
    upload_blob: createUploadBlobTool,

    // RAG tools
    rag_create_collection: createRAGCreateCollectionTool,
    rag_add_documents: createRAGAddDocumentsTool,
    rag_delete_collection: createRAGDeleteCollectionTool,
    rag_list_collections: createRAGListCollectionsTool,

    // RAG subscription tools
    rag_subscription_create: createRAGSubscriptionCreateTool,
    rag_subscription_list: createRAGSubscriptionListTool,
    rag_subscription_get: createRAGSubscriptionGetTool,
    rag_subscription_delete: createRAGSubscriptionDeleteTool,

    // MCP tools
    mcp_resource_read: createMcpResourceReadTool,
    mcp_subscribe: createMcpSubscribeTool as ToolFactory,
    mcp_subscription_stop: createMcpSubscriptionStopTool,

    // Todo tools - require ConversationToolContext (filtered out when no conversation)
    todo_write: createTodoWriteTool as ToolFactory,

    // Web tools
    web_fetch: createWebFetchTool,
    web_search: createWebSearchTool,

    // Nostr tools
    nostr_fetch: createNostrFetchTool,
    nostr_publish_as_user: createNostrPublishAsUserTool,

    // Image generation
    generate_image: createGenerateImageTool,

    // Meta model tools - requires ConversationToolContext (filtered out when no conversation)
    change_model: createChangeModelTool as ToolFactory,

    // Home-scoped filesystem tools (for agents without fs_* tools)
    home_fs_read: createHomeFsReadTool,
    home_fs_write: createHomeFsWriteTool,
    home_fs_grep: createHomeFsGrepTool,
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

/** File editing tools - auto-injected when fs_write is available */
const FILE_EDIT_TOOLS: ToolName[] = ["fs_edit"];

/** File search tools - auto-injected when fs_read is available */
const FILE_SEARCH_TOOLS: ToolName[] = ["fs_glob", "fs_grep"];

/** Todo tools - for restricted agent execution (reminder mode) */
const TODO_TOOLS: ToolName[] = ["todo_write"];

/** Meta model tools - auto-injected when agent uses a meta model configuration */
const META_MODEL_TOOLS: ToolName[] = ["change_model"];

/** Home-scoped filesystem tools - auto-injected when agent lacks fs_* tools */
const HOME_FS_TOOLS: ToolName[] = ["home_fs_read", "home_fs_write", "home_fs_grep"];

/** Full filesystem tool names - used to check if agent has fs access */
const FS_TOOL_NAMES: ToolName[] = ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep"];

/**
 * Check if an agent has stoppable MCP subscriptions (ACTIVE or ERROR).
 * Wrapped in a function to handle cases where the service isn't initialized.
 */
function mcpSubscriptionServiceHasStoppableSubscriptions(agentPubkey: string): boolean {
    try {
        const service = McpSubscriptionService.getInstance();
        return service.hasStoppableSubscriptions(agentPubkey);
    } catch {
        return false;
    }
}

/**
 * Get tools as a keyed object (for AI SDK usage)
 * @param names - Tool names to include (can include MCP tool names)
 * @param context - Registry context
 * @param nudgePermissions - Optional tool permissions from nudge events
 * @returns Object with tools keyed by name (returns the underlying CoreTool)
 */
export function getToolsObject(
    names: string[],
    context: ToolRegistryContext,
    nudgePermissions?: NudgeToolPermissions
): Record<string, CoreTool<unknown, unknown>> {
    const tools: Record<string, CoreTool<unknown, unknown>> = {};

    // Check if conversation is available
    const hasConversation = context.getConversation?.() !== undefined;

    // === ONLY-TOOL MODE: STRICT EXCLUSIVITY ===
    // When only-tool mode is active, return EXACTLY those tools - no auto-injection whatsoever.
    // This is a security feature: the nudge author has complete control over available tools.
    //
    // IMPORTANT: Core agent tools (like 'kill') are NOT auto-injected in only-tool mode.
    // If the nudge author wants core tools, they must explicitly include them in onlyTools.
    // This ensures the nudge author has complete, unambiguous control over the tool set.
    if (nudgePermissions && isOnlyToolMode(nudgePermissions)) {
        const onlyToolNames = nudgePermissions.onlyTools!;
        logger.debug("[ToolRegistry] Nudge only-tool mode: strict exclusive tool set", {
            originalTools: names.length,
            onlyTools: onlyToolNames,
        });

        // Separate regular tools and MCP tools
        const regularTools: ToolName[] = [];
        const mcpToolNames: string[] = [];

        for (const name of onlyToolNames) {
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

        // Add ONLY the explicitly requested regular tools - NO auto-injection
        for (const name of regularTools) {
            const tool = getTool(name, context as ToolExecutionContext);
            if (tool) {
                tools[name] = tool;
            }
        }

        // Add ONLY the explicitly requested MCP tools - NO auto-injection
        if (mcpToolNames.length > 0 && "mcpManager" in context && context.mcpManager) {
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

        // Return immediately - no further processing or auto-injection
        return tools;
    }

    // === ALLOW/DENY MODE OR NO NUDGE PERMISSIONS ===
    // In allow/deny mode, the base tool set is modified by allow-tool and deny-tool directives.
    //
    // POLICY:
    // 1. Initial filtering: deny-tool removes tools from base set
    // 2. Auto-injection: Core tools, etc. are added
    // 3. Final enforcement: deny-tool is re-applied to block any auto-injected tools
    // - This ensures deny-tool CAN block core tools if explicitly denied (e.g., deny-tool: kill)
    // - Provides flexibility: nudges can restrict even critical tools when needed
    let effectiveNames = names;

    if (nudgePermissions) {
        // allow-tool / deny-tool mode
        let modifiedNames = [...names];

        // Add allowed tools (that aren't already in the list)
        if (nudgePermissions.allowTools && nudgePermissions.allowTools.length > 0) {
            for (const allowTool of nudgePermissions.allowTools) {
                if (!modifiedNames.includes(allowTool)) {
                    modifiedNames.push(allowTool);
                }
            }
            logger.debug("[ToolRegistry] Nudge allow-tool: added tools", {
                allowedTools: nudgePermissions.allowTools,
            });
        }

        // Remove denied tools
        if (nudgePermissions.denyTools && nudgePermissions.denyTools.length > 0) {
            modifiedNames = modifiedNames.filter(
                (name) => !nudgePermissions.denyTools!.includes(name)
            );
            logger.debug("[ToolRegistry] Nudge deny-tool: removed tools", {
                deniedTools: nudgePermissions.denyTools,
            });
        }

        effectiveNames = modifiedNames;
    }

    // Separate regular tools and MCP tools
    const regularTools: ToolName[] = [];
    const mcpToolNames: string[] = [];

    for (const name of effectiveNames) {
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

    // Auto-inject core agent tools for all agents (critical system capabilities)
    // GATING: Only inject when conversation context is present to prevent leakage into non-agent contexts
    // Contexts without conversations (e.g., isolated tool execution) are excluded from core tool injection
    if (hasConversation) {
        for (const coreToolName of CORE_AGENT_TOOLS) {
            if (!regularTools.includes(coreToolName)) {
                regularTools.push(coreToolName);
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

    // Auto-inject search tools when fs_read is available
    // fs_read implies full read capability: glob + grep
    if (regularTools.includes("fs_read")) {
        for (const searchToolName of FILE_SEARCH_TOOLS) {
            if (!regularTools.includes(searchToolName)) {
                regularTools.push(searchToolName);
            }
        }
    }

    // Auto-inject change_model tool when agent uses a meta model configuration
    // Only inject if we have conversation context (needed for variant override persistence)
    if (hasConversation && "agent" in context && context.agent?.llmConfig) {
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

    // Auto-inject home_fs_* tools when agent lacks any fs_* tools
    // This gives restricted agents filesystem access limited to their home directory
    const hasAnyFsTool = FS_TOOL_NAMES.some((fsToolName) => regularTools.includes(fsToolName));
    if (!hasAnyFsTool) {
        for (const homeFsToolName of HOME_FS_TOOLS) {
            if (!regularTools.includes(homeFsToolName)) {
                regularTools.push(homeFsToolName);
            }
        }
    }

    // Auto-inject mcp_subscription_stop when agent has active MCP subscriptions
    if (hasConversation && "agent" in context && context.agent?.pubkey) {
        try {
            if (mcpSubscriptionServiceHasStoppableSubscriptions(context.agent.pubkey)) {
                if (!regularTools.includes("mcp_subscription_stop")) {
                    regularTools.push("mcp_subscription_stop");
                }
            }
        } catch {
            // McpSubscriptionService not initialized - skip injection
        }
    }

    // === FINAL DENY-TOOL ENFORCEMENT ===
    // Apply deny-tool filtering AFTER all auto-injection (core tools, edit, meta-model)
    // This ensures deny-tool can block even core tools if explicitly denied
    if (nudgePermissions?.denyTools && nudgePermissions.denyTools.length > 0) {
        const beforeDenyCount = regularTools.length;
        const deniedTools = regularTools.filter((name) => nudgePermissions.denyTools!.includes(name));

        if (deniedTools.length > 0) {
            // Remove denied tools (including auto-injected ones)
            const filtered = regularTools.filter((name) => !nudgePermissions.denyTools!.includes(name));
            regularTools.length = 0;
            regularTools.push(...filtered);

            logger.info("[ToolRegistry] Final deny-tool enforcement: blocked auto-injected tools", {
                deniedTools,
                beforeCount: beforeDenyCount,
                afterCount: regularTools.length,
            });
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
    if (mcpToolNames.length > 0 && "mcpManager" in context && context.mcpManager) {
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
