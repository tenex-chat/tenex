/**
 * Tool Registry - AI SDK Tools
 *
 * Central registry for all AI SDK tools in the TENEX system.
 */

import { config as configService } from "@/services/ConfigService";
import { isMetaModelConfiguration } from "@/services/config/types";
import { getTransportBindingStore } from "@/services/ingress/TransportBindingStoreService";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import type { SkillToolPermissions } from "@/services/skill";
import { isOnlyToolMode } from "@/services/skill";
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
import { filterDelegateToolsForAgentCategory, getCoreToolsForAgent } from "@/agents/constants";
import { createAskTool } from "./implementations/ask";
import { createDelegateTool } from "./implementations/delegate";
import { createDelegateCrossProjectTool } from "./implementations/delegate_crossproject";
import { createDelegateFollowupTool } from "./implementations/delegate_followup";
import { createKillTool } from "./implementations/kill";
import { createLessonLearnTool } from "./implementations/learn";
import { createNoResponseTool } from "./implementations/no_response";
// Todo tools
import { createTodoWriteTool } from "./implementations/todo";

// Skills tools
import { createSkillListTool } from "./implementations/skill_list";
import { createSkillsSetTool } from "./implementations/skills_set";

// Channel messaging tools
import { createSendMessageTool } from "./implementations/send_message";

// Meta model tools
import { createChangeModelTool } from "./implementations/change_model";
import { createSelfDelegateTool } from "./implementations/self_delegate";

// Home-scoped filesystem tools
import { getOrCreateHomeFsTools } from "./implementations/fs-tools-factory";

/**
 * Tools that require conversation context to function.
 * These are filtered out when no conversation is available (e.g., MCP context).
 */
const CONVERSATION_REQUIRED_TOOLS: Set<ToolName> = new Set([
    "todo_write",
    "change_model", // Needs conversation to persist variant override
    "self_delegate", // Needs conversation state for delegation registration/markers
    "skills_set", // Needs conversation to store self-applied skills
]);

/**
 * Registry of tool factories.
 * All tools receive ToolExecutionContext - tools that don't need
 * agentPublisher/ralNumber simply ignore those fields.
 */
/**
 * Registry of tool factories for tools that are always available in the system.
 * Skill-provided tools (shell, RAG, conversation_search, nostr) are NOT here —
 * they are loaded on-demand via SkillToolLoader when their skill is activated.
 */
const toolFactories: Partial<Record<ToolName, ToolFactory>> = {
    // Ask tool
    ask: createAskTool,

    // Delegation tools
    delegate_crossproject: createDelegateCrossProjectTool,
    delegate_followup: createDelegateFollowupTool,
    delegate: createDelegateTool,
    self_delegate: createSelfDelegateTool as ToolFactory,

    // Lesson tools
    lesson_learn: createLessonLearnTool,

    // Process control
    kill: createKillTool as ToolFactory,
    no_response: createNoResponseTool,

    // Todo tools - require ConversationToolContext (filtered out when no conversation)
    todo_write: createTodoWriteTool as ToolFactory,

    // Skills management
    skill_list: createSkillListTool,
    skills_set: createSkillsSetTool as ToolFactory,

    // Meta model tools - requires ConversationToolContext (filtered out when no conversation)
    change_model: createChangeModelTool as ToolFactory,

    // Channel messaging tools (auto-injected when agent has remembered transport bindings)
    send_message: createSendMessageTool,

    // Home-scoped filesystem tools (auto-injected when fs_* counterparts unavailable)
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

    if (name === "self_delegate") {
        return context.triggeringEnvelope.principal.linkedPubkey !== context.agent.pubkey;
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

/** Meta model tools - auto-injected when agent uses a meta model configuration */
const META_MODEL_TOOLS: ToolName[] = ["change_model"];

/**
 * Mapping from fs_* capabilities to their home_fs_* fallbacks.
 * When an agent lacks a given fs_* tool, the corresponding home_fs_* tools are injected.
 * This is processed AFTER skill tools are loaded to avoid duplicates.
 */
export const HOME_FS_FALLBACKS: [ToolName, ToolName[]][] = [
    ["fs_read", ["home_fs_read"]],
    ["fs_write", ["home_fs_write", "home_fs_edit"]],
    ["fs_glob", ["home_fs_glob"]],
    ["fs_grep", ["home_fs_grep"]],
];

/**
 * Get tools as a keyed object (for AI SDK usage)
 * @param names - Tool names to include (can include MCP tool names)
 * @param context - Registry context
 * @param skillPermissions - Optional tool permissions from skill events
 * @returns Object with tools keyed by name (returns the underlying CoreTool)
 */
export function getToolsObject(
    names: string[],
    context: ToolRegistryContext,
    skillPermissions?: SkillToolPermissions
): Record<string, CoreTool<unknown, unknown>> {
    const tools: Record<string, CoreTool<unknown, unknown>> = {};

    // Check if conversation is available
    const hasConversation = context.getConversation?.() !== undefined;

    // === ONLY-TOOL MODE: STRICT EXCLUSIVITY ===
    // When only-tool mode is active, return EXACTLY those tools allowed by
    // category policy - no auto-injection whatsoever.
    // This is a security feature: the skill author has complete control over the
    // category-allowed tool subset.
    //
    // IMPORTANT: Core agent tools (like 'kill') are NOT auto-injected in only-tool mode.
    // If the skill author wants core tools, they must explicitly include them in onlyTools.
    // This ensures the skill author has complete, unambiguous control within
    // the agent's category policy.
    if (skillPermissions && isOnlyToolMode(skillPermissions)) {
        const onlyToolNames = filterDelegateToolsForAgentCategory(
            skillPermissions.onlyTools ?? [],
            context.agent.category
        );
        logger.debug("[ToolRegistry] Skill only-tool mode: strict exclusive tool set", {
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

    // === ALLOW/DENY MODE OR NO SKILL PERMISSIONS ===
    // In allow/deny mode, the base tool set is modified by allow-tool and deny-tool directives.
    //
    // POLICY:
    // 1. Initial filtering: deny-tool removes tools from base set
    // 2. Auto-injection: Core tools, etc. are added
    // 3. Final enforcement: deny-tool is re-applied to block any auto-injected tools
    // - This ensures deny-tool CAN block core tools if explicitly denied (e.g., deny-tool: kill)
    // - Provides flexibility: skills can restrict even critical tools when needed
    let effectiveNames = names;

    if (skillPermissions) {
        // allow-tool / deny-tool mode
        let modifiedNames = [...names];

        // Add allowed tools (that aren't already in the list)
        if (skillPermissions.allowTools && skillPermissions.allowTools.length > 0) {
            for (const allowTool of skillPermissions.allowTools) {
                if (!modifiedNames.includes(allowTool)) {
                    modifiedNames.push(allowTool);
                }
            }
            logger.debug("[ToolRegistry] Skill allow-tool: added tools", {
                allowedTools: skillPermissions.allowTools,
            });
        }

        // Remove denied tools
        const deniedTools = skillPermissions.denyTools;
        if (deniedTools && deniedTools.length > 0) {
            modifiedNames = modifiedNames.filter((name) => !deniedTools.includes(name));
            logger.debug("[ToolRegistry] Skill deny-tool: removed tools", {
                deniedTools,
            });
        }

        effectiveNames = modifiedNames;
    }

    effectiveNames = filterDelegateToolsForAgentCategory(effectiveNames, context.agent.category);

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
        const coreToolNames = getCoreToolsForAgent(context.agent.category);
        for (const coreToolName of coreToolNames) {
            if (!regularTools.includes(coreToolName)) {
                regularTools.push(coreToolName);
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

    // Auto-inject home_fs_* tools (fallback filesystem access)
    // These are automatically removed later if fs_* counterparts are loaded via skills
    for (const [_, homeFallbacks] of HOME_FS_FALLBACKS) {
        for (const fallback of homeFallbacks) {
            if (!regularTools.includes(fallback)) {
                regularTools.push(fallback);
            }
        }
    }

    // === FINAL DENY-TOOL ENFORCEMENT ===
    // Apply deny-tool filtering AFTER all auto-injection (core tools, edit, meta-model)
    // This ensures deny-tool can block even core tools if explicitly denied
    const deniedTools = skillPermissions?.denyTools;
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
