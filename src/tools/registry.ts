/**
 * Tool Registry - AI SDK Tools
 *
 * Central registry for all AI SDK tools in the TENEX system.
 */

import { config as configService } from "@/services/ConfigService";
import { isMetaModelConfiguration } from "@/services/config/types";
import { getTransportBindingStore } from "@/services/ingress/TransportBindingStoreService";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
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
import { createAgentsWriteTool } from "./implementations/agents_write";
import { createAskTool } from "./implementations/ask";
import { createConversationGetTool } from "./implementations/conversation_get";
import { createConversationListTool } from "./implementations/conversation_list";
import { createConversationSearchTool } from "./implementations/conversation_search";
import { createDelegateTool } from "./implementations/delegate";
import { createDelegateCrossProjectTool } from "./implementations/delegate_crossproject";
import { createDelegateFollowupTool } from "./implementations/delegate_followup";
import { createFsTools } from "ai-sdk-fs-tools";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { attachTranscriptArgs } from "@/tools/utils/transcript-args";
import { synthesizeContent, executeReadToolResult } from "./implementations/fs-hooks";
import { createKillTool } from "./implementations/kill";
import { createLessonLearnTool } from "./implementations/learn";
import { createNoResponseTool } from "./implementations/no_response";
import { createProjectListTool } from "./implementations/project_list";
import { createRAGAddDocumentsTool } from "./implementations/rag_add_documents";
import { createRAGCollectionCreateTool } from "./implementations/rag_collection_create";
import { createRAGCollectionDeleteTool } from "./implementations/rag_collection_delete";
import { createRAGCollectionListTool } from "./implementations/rag_collection_list";

import { createRAGSubscriptionCreateTool } from "./implementations/rag_subscription_create";
import { createRAGSubscriptionDeleteTool } from "./implementations/rag_subscription_delete";
import { createRAGSubscriptionGetTool } from "./implementations/rag_subscription_get";
import { createRAGSubscriptionListTool } from "./implementations/rag_subscription_list";
import { createMcpResourceReadTool } from "./implementations/mcp_resource_read";
import { createMcpSubscribeTool } from "./implementations/mcp_subscribe";
import { createMcpSubscriptionStopTool } from "./implementations/mcp_subscription_stop";
import { McpSubscriptionService } from "@/services/mcp/McpSubscriptionService";
import { createScheduleTaskTool } from "./implementations/schedule_task";
import { createShellTool } from "./implementations/shell";
// Todo tools
import { createTodoWriteTool } from "./implementations/todo";

// Nostr tools
import { createNostrPublishAsUserTool } from "./implementations/nostr_publish_as_user";

// Unified RAG search tool
import { createRAGSearchTool } from "./implementations/rag_search";

// Skills tools
import { createSkillsSetTool } from "./implementations/skills_set";

// Channel messaging tools
import { createSendMessageTool } from "./implementations/send_message";

// Meta model tools
import { createChangeModelTool } from "./implementations/change_model";

// Home-scoped filesystem tools - provided by ai-sdk-fs-tools with home_fs prefix
import { ensureAgentHomeDirectory } from "@/lib/agent-home";

const tenexFsToolsCache = new WeakMap<ToolExecutionContext, ReturnType<typeof createFsTools>>();

function getOrCreateTenexFsTools(context: ToolExecutionContext): ReturnType<typeof createFsTools> {
    let tools = tenexFsToolsCache.get(context);
    if (!tools) {
        tools = createTenexFsToolsUncached(context);
        tenexFsToolsCache.set(context, tools);
    }
    return tools;
}

function createTenexFsToolsUncached(context: ToolExecutionContext): ReturnType<typeof createFsTools> {
    const allowedRoots = [context.projectBasePath, getAgentHomeDirectory(context.agent.pubkey)]
        .filter((p): p is string => typeof p === "string" && p.trim() !== "");

    const tools = createFsTools({
        workingDirectory: context.workingDirectory,
        allowedRoots,
        agentsMd: { projectRoot: context.projectBasePath ?? context.workingDirectory, skipRoot: true },
        formatOutsideRootsError: (path, wd) =>
            `Path "${path}" is outside your working directory "${wd}". If this was intentional, retry with allowOutsideWorkingDirectory: true`,
        analyzeContent: ({ content, prompt, source }) => synthesizeContent(content, prompt, source),
        loadToolResult: (toolCallId) =>
            executeReadToolResult(context.conversationId, toolCallId),
    });

    attachTranscriptArgs(tools.fs_read as AISdkTool, [{ key: "path", attribute: "file_path" }]);
    attachTranscriptArgs(tools.fs_write as AISdkTool, [{ key: "path", attribute: "file_path" }]);

    return tools;
}

const homeFsToolsCache = new WeakMap<ToolExecutionContext, ReturnType<typeof createFsTools>>();

function getOrCreateHomeFsTools(context: ToolExecutionContext): ReturnType<typeof createFsTools> {
    let tools = homeFsToolsCache.get(context);
    if (!tools) {
        const homeDir = getAgentHomeDirectory(context.agent.pubkey);
        ensureAgentHomeDirectory(context.agent.pubkey);
        tools = createFsTools({
            workingDirectory: homeDir,
            namePrefix: "home_fs",
            strictContainment: true,
            agentsMd: false,
            descriptions: {
                read: "Read a file or directory listing from your home directory. Returns contents with line numbers. Use offset/limit to paginate large files.",
                write: "Write content to a file in your home directory. Creates parent directories automatically. Overwrites existing files.",
                edit: "Edit a file in your home directory by replacing a specific string with a new string.",
                glob: "Find files by glob pattern within your home directory.",
                grep: "Search for patterns in files within your home directory. Uses ripgrep. Supports regex patterns.",
            },
            formatOutsideRootsError: (path) =>
                `Path "${path}" is outside your home directory. You can only access files within your home directory.`,
        });
        homeFsToolsCache.set(context, tools);
    }
    return tools;
}

/**
 * Tools that require conversation context to function.
 * These are filtered out when no conversation is available (e.g., MCP context).
 */
const CONVERSATION_REQUIRED_TOOLS: Set<ToolName> = new Set([
    "todo_write",
    "conversation_get", // Needs conversation for current-conversation optimization
    "change_model", // Needs conversation to persist variant override
    "mcp_subscribe", // Needs conversation to bind subscription to it
    "skills_set", // Needs conversation to store self-applied skills
]);

/**
 * Registry of tool factories.
 * All tools receive ToolExecutionContext - tools that don't need
 * agentPublisher/ralNumber simply ignore those fields.
 */
const toolFactories: Record<ToolName, ToolFactory> = {
    // Agent tools
    agents_write: createAgentsWriteTool,

    // Ask tool
    ask: createAskTool,

    // File search tools
    fs_glob: (ctx) => getOrCreateTenexFsTools(ctx).fs_glob as AISdkTool,
    fs_grep: (ctx) => getOrCreateTenexFsTools(ctx).fs_grep as AISdkTool,

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
    lesson_learn: createLessonLearnTool,

    fs_read: (ctx) => getOrCreateTenexFsTools(ctx).fs_read as AISdkTool,
    fs_write: (ctx) => getOrCreateTenexFsTools(ctx).fs_write as AISdkTool,
    fs_edit: (ctx) => getOrCreateTenexFsTools(ctx).fs_edit as AISdkTool,
    // Schedule tools
    schedule_task: createScheduleTaskTool,

    // Conversation search
    conversation_search: createConversationSearchTool,

    // Unified RAG search across all project knowledge
    rag_search: createRAGSearchTool,

    shell: createShellTool,
    kill: createKillTool,
    no_response: createNoResponseTool,

    // RAG tools
    rag_collection_create: createRAGCollectionCreateTool,
    rag_add_documents: createRAGAddDocumentsTool,
    rag_collection_delete: createRAGCollectionDeleteTool,
    rag_collection_list: createRAGCollectionListTool,

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

    // Nostr tools
    nostr_publish_as_user: createNostrPublishAsUserTool,

    skills_set: createSkillsSetTool as ToolFactory,

    // Meta model tools - requires ConversationToolContext (filtered out when no conversation)
    change_model: createChangeModelTool as ToolFactory,

    // Channel messaging tools (auto-injected when agent has remembered transport bindings)
    send_message: createSendMessageTool,

    // Home-scoped filesystem tools (for agents without fs_* tools)
    home_fs_read: (ctx) => getOrCreateHomeFsTools(ctx).home_fs_read as AISdkTool,
    home_fs_write: (ctx) => getOrCreateHomeFsTools(ctx).home_fs_write as AISdkTool,
    home_fs_edit: (ctx) => getOrCreateHomeFsTools(ctx).home_fs_edit as AISdkTool,
    home_fs_glob: (ctx) => getOrCreateHomeFsTools(ctx).home_fs_glob as AISdkTool,
    home_fs_grep: (ctx) => getOrCreateHomeFsTools(ctx).home_fs_grep as AISdkTool,
};

function isToolAvailableInContext(name: ToolName, context: ToolExecutionContext): boolean {
    if (name === "no_response") {
        return context.triggeringEnvelope.transport === "telegram";
    }

    return true;
}

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
    if (!isToolAvailableInContext(name, context)) {
        return undefined;
    }

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

/** Meta model tools - auto-injected when agent uses a meta model configuration */
const META_MODEL_TOOLS: ToolName[] = ["change_model"];

/**
 * Mapping from fs_* capabilities to their home_fs_* fallbacks.
 * When an agent lacks a given fs_* tool, the corresponding home_fs_* tools are injected.
 */
const HOME_FS_FALLBACKS: [ToolName, ToolName[]][] = [
    ["fs_read", ["home_fs_read"]],
    ["fs_write", ["home_fs_write", "home_fs_edit"]],
    ["fs_glob", ["home_fs_glob"]],
    ["fs_grep", ["home_fs_grep"]],
];

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
        const onlyToolNames = nudgePermissions.onlyTools ?? [];
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
        const deniedTools = nudgePermissions.denyTools;
        if (deniedTools && deniedTools.length > 0) {
            modifiedNames = modifiedNames.filter((name) => !deniedTools.includes(name));
            logger.debug("[ToolRegistry] Nudge deny-tool: removed tools", {
                deniedTools,
            });
        }

        effectiveNames = modifiedNames;
    }

    // Separate regular tools (MCP tools are injected via mcpAccess, not via tool names)
    const regularTools: ToolName[] = [];

    for (const name of effectiveNames) {
        if (name.startsWith("mcp__")) {
            // mcp__ entries in tool lists are no longer valid; they are injected via mcpAccess
            continue;
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

    // Auto-inject home_fs_* fallbacks per capability when agent lacks the fs_* equivalent
    for (const [fsTool, homeFallbacks] of HOME_FS_FALLBACKS) {
        if (!regularTools.includes(fsTool)) {
            for (const fallback of homeFallbacks) {
                if (!regularTools.includes(fallback)) {
                    regularTools.push(fallback);
                }
            }
        }
    }

    // Auto-inject send_message when agent has remembered Telegram transport bindings
    if (
        hasConversation &&
        "agent" in context &&
        context.agent?.telegram?.botToken &&
        isProjectContextInitialized()
    ) {
        const projectId = getProjectContext().project.dTag ?? getProjectContext().project.tagValue("d");
        const hasTelegramBindings = Boolean(
            projectId &&
            context.agent.pubkey &&
            getTransportBindingStore()
                .listBindingsForAgentProject(context.agent.pubkey, projectId, "telegram")
                .length > 0
        );

        if (hasTelegramBindings && !regularTools.includes("send_message")) {
            regularTools.push("send_message");
        }
    }

    if (
        hasConversation &&
        context.triggeringEnvelope.transport === "telegram" &&
        !regularTools.includes("no_response")
    ) {
        regularTools.push("no_response");
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
    const deniedTools = nudgePermissions?.denyTools;
    if (deniedTools && deniedTools.length > 0) {
        const beforeDenyCount = regularTools.length;
        const deniedPresent = regularTools.filter((name) => deniedTools.includes(name));

        if (deniedPresent.length > 0) {
            // Remove denied tools (including auto-injected ones)
            const filtered = regularTools.filter((name) => !deniedTools.includes(name));
            regularTools.length = 0;
            regularTools.push(...filtered);

            logger.info("[ToolRegistry] Final deny-tool enforcement: blocked auto-injected tools", {
                deniedTools: deniedPresent,
                beforeCount: beforeDenyCount,
                afterCount: regularTools.length,
            });
        }
    }

    // Add regular tools (cast to ToolExecutionContext - filtered tools won't need conversation)
    for (const name of regularTools) {
        const tool = getTool(name, context as ToolExecutionContext);
        if (tool) {
            tools[name] = tool;
        }
    }

    // Inject all MCP tools from servers the agent has access to via mcpAccess
    if ("agent" in context && context.agent?.mcpAccess && context.agent.mcpAccess.length > 0 && "mcpManager" in context && context.mcpManager) {
        try {
            const accessibleServerSlugs = new Set(context.agent.mcpAccess);
            const allMcpTools = context.mcpManager.getCachedTools();
            for (const [toolName, mcpTool] of Object.entries(allMcpTools)) {
                // Parse server name from mcp__{serverName}__{toolName}
                const parts = toolName.split("__");
                if (parts.length < 3 || parts[0] !== "mcp") continue;
                const serverSlug = parts[1];
                // Skip internal tenex tools
                if (serverSlug === "tenex") continue;
                // Only inject tools from servers the agent has access to
                if (accessibleServerSlugs.has(serverSlug)) {
                    tools[toolName] = asTool(mcpTool);
                }
            }
        } catch (error) {
            logger.debug("Could not load MCP tools:", error);
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
