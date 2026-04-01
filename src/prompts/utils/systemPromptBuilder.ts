import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { MCPManager } from "@/services/mcp/MCPManager";
import { isOnlyToolMode, type NudgeToolPermissions, type NudgeData } from "@/services/nudge";
import type { SkillData } from "@/services/skill";
import { getTransportBindingStore } from "@/services/ingress/TransportBindingStoreService";
import { getIdentityBindingStore } from "@/services/identity";
import { getProjectContext } from "@/services/projects";
import { SchedulerService } from "@/services/scheduling";
import { getTelegramChatContextStore } from "@/services/telegram/TelegramChatContextStoreService";
import { parseTelegramChannelId } from "@/utils/telegram-identifiers";
import { RAGService } from "@/services/rag/RAGService";
import { logger } from "@/utils/logger";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { createProjectDTag, type ProjectDTag } from "@/types/project-ids";
import type { ModelMessage } from "ai";
import { trace } from "@opentelemetry/api";

// Import fragment registration manifest
import "@/prompts/fragments"; // This auto-registers all fragments
import { fetchAgentMcpResources } from "@/prompts/fragments/26-mcp-resources";

const ROOT_AGENTS_MD_CACHE_TTL_MS = 30_000;

interface RootAgentsMdCacheEntry {
    expiresAt: number;
    hasRootAgentsMd: boolean;
    rootAgentsMdContent?: string;
}

const rootAgentsMdCache = new Map<string, RootAgentsMdCacheEntry>();

async function getCachedRootAgentsMd(
    projectBasePath: string
): Promise<{ hasRootAgentsMd: boolean; rootAgentsMdContent?: string }> {
    const cached = rootAgentsMdCache.get(projectBasePath);
    if (cached && cached.expiresAt > Date.now()) {
        return {
            hasRootAgentsMd: cached.hasRootAgentsMd,
            rootAgentsMdContent: cached.rootAgentsMdContent,
        };
    }

    const agentsMdPath = path.join(projectBasePath, "AGENTS.md");

    try {
        const rootAgentsMdContent = await fs.readFile(agentsMdPath, "utf-8");
        const entry: RootAgentsMdCacheEntry = {
            expiresAt: Date.now() + ROOT_AGENTS_MD_CACHE_TTL_MS,
            hasRootAgentsMd: true,
            rootAgentsMdContent,
        };
        rootAgentsMdCache.set(projectBasePath, entry);
        return {
            hasRootAgentsMd: true,
            rootAgentsMdContent,
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            const entry: RootAgentsMdCacheEntry = {
                expiresAt: Date.now() + ROOT_AGENTS_MD_CACHE_TTL_MS,
                hasRootAgentsMd: false,
            };
            rootAgentsMdCache.set(projectBasePath, entry);
            return {
                hasRootAgentsMd: false,
                rootAgentsMdContent: undefined,
            };
        }
        throw error;
    }
}

/**
 * List of scheduling-related tools that trigger the scheduled tasks context
 */
const SCHEDULING_TOOLS = ["schedule_task"] as const;

function formatHandle(username: string | undefined): string {
    return username ? ` (@${username})` : "";
}

function formatIdentityLabel(
    displayName: string | undefined,
    username: string | undefined,
    fallback: string
): string {
    const base = displayName ?? username ?? fallback;
    if (!username || base === username) {
        return base;
    }
    return `${base}${formatHandle(username)}`;
}

function describeTelegramChannelBinding(
    projectId: string,
    agentPubkey: string,
    channelId: string
): string | undefined {
    const parsed = parseTelegramChannelId(channelId);
    if (!parsed) {
        return undefined;
    }

    if (!parsed.chatId.startsWith("-")) {
        const identity = getIdentityBindingStore().getBinding(`telegram:user:${parsed.chatId}`);
        return `Telegram DM with ${formatIdentityLabel(
            identity?.displayName,
            identity?.username,
            parsed.chatId
        )}`;
    }

    const chatContext = getTelegramChatContextStore().getContext(projectId, agentPubkey, channelId);
    if (!chatContext?.chatTitle && !chatContext?.chatUsername) {
        return parsed.messageThreadId ? "Telegram topic" : "Telegram chat";
    }

    const title = chatContext.chatTitle
        ? `"${chatContext.chatTitle}"`
        : chatContext.chatUsername
          ? `@${chatContext.chatUsername}`
          : undefined;
    if (!title) {
        return parsed.messageThreadId ? "Telegram topic" : "Telegram chat";
    }

    if (parsed.messageThreadId) {
        const topicLabel = chatContext.topicTitle
            ? `Telegram topic "${chatContext.topicTitle}" in ${title}`
            : `Telegram topic in ${title}`;
        return topicLabel;
    }

    return `Telegram chat ${title}`;
}

function buildChannelBindingDisplayEntries(agent: AgentInstance, projectId: string): Array<{
    channelId: string;
    description?: string;
}> {
    if (!agent.pubkey || !agent.telegram?.botToken) {
        return [];
    }

    return getTransportBindingStore()
        .listBindingsForAgentProject(agent.pubkey, projectId, "telegram")
        .map((binding) => ({
            channelId: binding.channelId,
            description: describeTelegramChannelBinding(projectId, agent.pubkey, binding.channelId),
        }));
}

export interface BuildSystemPromptOptions {
    // Required data
    agent: AgentInstance;
    project: NDKProject;
    conversation: ConversationStore;
    triggeringEnvelope?: InboundEnvelope;

    /**
     * Project directory (normal git repository root).
     * Example: ~/tenex/{dTag}
     * Worktrees are in .worktrees/ subdirectory.
     */
    projectBasePath?: string;

    /**
     * Working directory for code execution.
     * - Default branch: same as projectBasePath (~/tenex/{dTag})
     * - Feature branch: ~/tenex/{dTag}/.worktrees/feature_branch/
     * This is displayed as "Absolute Path" in the system prompt.
     */
    workingDirectory?: string;

    /**
     * Current git branch name.
     * Example: "master", "feature/branch-name", "research/foo"
     */
    currentBranch?: string;

    // Optional runtime data
    availableAgents?: AgentInstance[];
    isProjectManager?: boolean; // Indicates if this agent is the PM
    projectManagerPubkey?: string; // Pubkey of the project manager
    mcpManager?: MCPManager; // MCP manager for this project
    nudgeContent?: string; // Concatenated content from kind:4201 nudge events (legacy)
    /** Individual nudge data for rendering with titles */
    nudges?: NudgeData[];
    /** Tool permissions extracted from nudge events */
    nudgeToolPermissions?: NudgeToolPermissions;
    /** Concatenated content from kind:4202 skill events (legacy) */
    skillContent?: string;
    /** Individual skill data for rendering with files */
    skills?: SkillData[];
    /** Include MCP resource discovery in the system prompt. Defaults to true. */
    includeMcpResources?: boolean;
    /** Whether the scratchpad strategy is active. When false, omits the scratchpad-practice prompt fragment. Defaults to true. */
    scratchpadAvailable?: boolean;
}


export interface SystemMessage {
    message: ModelMessage;
    metadata?: {
        description?: string;
    };
}

/**
 * Add core agent fragments.
 * NOTE: Lessons are not added as raw fragments here. They are compiled into the
 * agent's effective instructions by the runtime-owned prompt compiler registry.
 */
async function addCoreAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    mcpManager?: MCPManager,
    parentSpan?: import("@opentelemetry/api").Span,
    includeMcpResources = true
): Promise<void> {
    // Add scheduled tasks context if agent has scheduling tools
    const hasSchedulingTools = agent.tools.some((tool) =>
        SCHEDULING_TOOLS.includes(tool as (typeof SCHEDULING_TOOLS)[number])
    );

    if (hasSchedulingTools) {
        try {
            const t0 = performance.now();
            const schedulerService = SchedulerService.getInstance();
            const allTasks = await schedulerService.getTasks();
            parentSpan?.addEvent("scheduled_tasks_fetched", { "duration_ms": Math.round(performance.now() - t0) });
            builder.add("scheduled-tasks", {
                agent,
                scheduledTasks: allTasks,
            });
        } catch (error) {
            // Scheduler might not be initialized yet, log and continue
            logger.debug("Could not fetch scheduled tasks for prompt:", error);
        }
    }

    // Add todo usage guidance if agent has todo tools
    if (agent.tools.includes("todo_add")) {
        builder.add("todo-usage-guidance", {});
    }

    // Add MCP resources if agent has any MCP tools and mcpManager is available
    if (includeMcpResources && mcpManager) {
        const t0 = performance.now();
        const resourcesPerServer = await fetchAgentMcpResources(agent.tools, mcpManager);
        parentSpan?.addEvent("mcp_resources_fetched", { "duration_ms": Math.round(performance.now() - t0) });
        if (resourcesPerServer.length > 0) {
            builder.add("mcp-resources", {
                agentPubkey: agent.pubkey,
                mcpEnabled: true,
                resourcesPerServer,
            });
        }
    }

    // Add RAG collection attribution - shows agents their contributions to RAG collections
    // This uses the provenance tracking metadata (agent_pubkey) from document ingestion
    try {
        const t0 = performance.now();
        const ragService = RAGService.getInstance();
        const collections = await ragService.getCachedAllCollectionStats(agent.pubkey);
        parentSpan?.addEvent("rag_collection_stats_fetched", { "duration_ms": Math.round(performance.now() - t0) });

        if (collections.length > 0) {
            builder.add("rag-collections", {
                agentPubkey: agent.pubkey,
                collections,
            });
            logger.debug("📊 Added RAG collection stats to system prompt", {
                agent: agent.name,
                collectionsWithContributions: collections.filter(c => c.agentDocCount > 0).length,
                totalCollections: collections.length,
            });
        }
    } catch (error) {
        logger.debug("Could not get RAG collection stats:", error);
    }
}

/**
 * Add agent-specific fragments
 */
function addAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    availableAgents: AgentInstance[],
    triggeringEnvelope?: BuildSystemPromptOptions["triggeringEnvelope"],
    projectManagerPubkey?: string,
    projectDTag?: string,
    projectPath?: string
): void {
    // Add available nudges and skills for delegation (priority 13, before available-agents)
    builder.add("available-nudges-and-skills", {
        agentPubkey: agent.pubkey,
        projectPath,
        projectDTag,
    });

    // Add available agents for delegations
    builder.add("available-agents", {
        agents: availableAgents,
        currentAgent: agent,
        projectManagerPubkey,
    });

    // Add delegation best practices guidance (priority 16, after available-agents)
    builder.add("stay-in-your-lane", {});

    // Add todo-before-delegation requirement (priority 17, after stay-in-your-lane)
    builder.add("todo-before-delegation", {});

    // Add delegation async pattern guidance (priority 19)
    builder.add("delegation-async", {});

    // Add explicit guidance for turns where the user wants no reply.
    if (triggeringEnvelope?.transport === "telegram") {
        builder.add("no-response-guidance", {
            triggeringEnvelope,
        });
    }
}

/**
 * Builds the system prompt messages for an agent, returning an array of messages
 * with optional caching metadata.
 * This is the single source of truth for system prompt generation.
 */
export async function buildSystemPromptMessages(
    options: BuildSystemPromptOptions
): Promise<SystemMessage[]> {
    const messages: SystemMessage[] = [];

    // Build the main system prompt
    const activeSpan = trace.getActiveSpan();
    const mainPrompt = await buildMainSystemPrompt(options, activeSpan);
    messages.push({
        message: { role: "system", content: mainPrompt },
        metadata: {
            description: "Main system prompt",
        },
    });

    return messages;
}

/**
 * Builds the main system prompt content.
 *
 * Uses the runtime-owned PromptCompilerRegistryService when available to resolve
 * Effective Agent Instructions. The result is then used when building fragments.
 *
 * IMPORTANT: The Effective Agent Instructions should contain ONLY:
 * - Base Agent Instructions (from agent.instructions in Kind 4199 event)
 * - Lessons learned and lesson comments (merged by LLM)
 *
 * Fragments (project context, worktrees, available agents, etc.) are added AFTER compilation.
 */
async function buildMainSystemPrompt(options: BuildSystemPromptOptions, parentSpan?: import("@opentelemetry/api").Span): Promise<string> {
    const {
        agent,
        project,
        triggeringEnvelope,
        projectBasePath,
        workingDirectory,
        currentBranch,
        availableAgents = [],
        conversation,
        mcpManager,
        nudgeContent,
        nudges,
        nudgeToolPermissions,
        skillContent,
        skills,
        includeMcpResources = true,
        scratchpadAvailable = true,
    } = options;

    const baseAgentInstructions = agent.instructions || "";
    const context = getProjectContext();
    const rawDTag = project.dTag;
    const dTag: ProjectDTag | undefined = rawDTag ? createProjectDTag(rawDTag) : undefined;
    const effectiveAgentInstructions = context.promptCompilerRegistry
        ? context.promptCompilerRegistry.getEffectiveInstructionsSync(agent.pubkey, baseAgentInstructions)
        : baseAgentInstructions;

    logger.debug("✅ Retrieved Effective Agent Instructions (sync)", {
        agentName: agent.name,
        baseInstructionsLength: baseAgentInstructions.length,
        effectiveInstructionsLength: effectiveAgentInstructions.length,
        usedPromptCompilerRegistry: !!context.promptCompilerRegistry,
    });

    // Create an agent copy with Effective Agent Instructions (if available)
    // This ensures fragments use the compiled version instead of raw Base Agent Instructions
    const agentForFragments: AgentInstance = effectiveAgentInstructions
        ? { ...agent, instructions: effectiveAgentInstructions }
        : agent;

    const systemPromptBuilder = new PromptBuilder();
    let t0: number;

    // Add agent identity - use workingDirectory for "Absolute Path" (where the agent operates)
    // NOTE: Uses agentForFragments which has Effective Agent Instructions (lessons merged in)
    systemPromptBuilder.add("agent-identity", {
        agent: agentForFragments,
        projectTitle: project.tagValue("title") || "Unknown Project",
        projectOwnerPubkey: project.pubkey,
        workingDirectory,
        conversationId: conversation.getId(),
    });

    // Add agent home directory context
    systemPromptBuilder.add("agent-home-directory", {
        agent: agentForFragments,
        projectDTag: dTag,
        projectDocsPath: projectBasePath ? path.join(projectBasePath, "tenex", "docs") : undefined,
    });

    // Explain <system-reminder> tags before agents encounter them
    systemPromptBuilder.add("system-reminders-explanation", {});

    if (scratchpadAvailable && (!nudgeToolPermissions || !isOnlyToolMode(nudgeToolPermissions))) {
        systemPromptBuilder.add("scratchpad-practice", {});
    }

    // Add global system prompt if configured (ordered by fragment priority)
    systemPromptBuilder.add("global-system-prompt", {});

    systemPromptBuilder.add("telegram-chat-context", {
        triggeringEnvelope,
    });
    systemPromptBuilder.add("telegram-delivery-rules", {
        triggeringEnvelope,
    });

    systemPromptBuilder.add("channel-bindings", {
        bindings: dTag ? buildChannelBindingDisplayEntries(agentForFragments, dTag) : [],
    });

    // Add delegation chain if present (shows agent their position in multi-agent workflow)
    // The chain entries already have full conversation IDs stored - no need to pass currentConversationId
    if (conversation?.metadata?.delegationChain && conversation.metadata.delegationChain.length > 0) {
        systemPromptBuilder.add("delegation-chain", {
            delegationChain: conversation.metadata.delegationChain,
            currentAgentPubkey: agentForFragments.pubkey,
            currentConversationId: conversation.getId(),
        });
    }

    // Add nudge content if present (from kind:4201 events referenced by the triggering event)
    // Now supports individual nudge data with tool permissions
    if ((nudges && nudges.length > 0) || (nudgeContent && nudgeContent.trim().length > 0)) {
        systemPromptBuilder.add("nudges", {
            nudgeContent,
            nudges,
            nudgeToolPermissions,
        });
    }

    // Add skill content if present. These can come from triggering-event skill tags,
    // self-applied conversation state, or always-on agent config.
    // Skills provide additional instructions and attached files, but do NOT modify tool permissions.
    if ((skills && skills.length > 0) || (skillContent && skillContent.trim().length > 0)) {
        systemPromptBuilder.add("skills", {
            skillContent,
            skills,
        });
    }

    // NOTE: agent-todos is NOT included here - it's injected as a late system message
    // in AgentExecutor.executeStreaming() to ensure it appears at the end of messages

    // Add worktree context if we have the necessary information
    if (workingDirectory && currentBranch && projectBasePath) {
        systemPromptBuilder.add("worktree-context", {
            context: {
                workingDirectory,
                currentBranch,
                projectBasePath,
                agent: agentForFragments,
            },
        });
    }

    // Add AGENTS.md guidance - always included to inform agents about the AGENTS.md system
    // When no AGENTS.md exists, the fragment explicitly states so
    if (projectBasePath) {
        try {
            t0 = performance.now();
            const { hasRootAgentsMd, rootAgentsMdContent } = await getCachedRootAgentsMd(projectBasePath);
            parentSpan?.addEvent("agents_md_read", { "duration_ms": Math.round(performance.now() - t0), "has_root_agents_md": hasRootAgentsMd });
            systemPromptBuilder.add("agents-md-guidance", {
                hasRootAgentsMd,
                rootAgentsMdContent,
            });
        } catch (error) {
            // AGENTS lookup failed - add fragment with no AGENTS.md state
            logger.debug("Could not check for root AGENTS.md:", error);
            systemPromptBuilder.add("agents-md-guidance", {
                hasRootAgentsMd: false,
                rootAgentsMdContent: undefined,
            });
        }
    } else {
        // No project base path - still add fragment to explain AGENTS.md system
        systemPromptBuilder.add("agents-md-guidance", {
            hasRootAgentsMd: false,
            rootAgentsMdContent: undefined,
        });
    }

    // Add tool description guidance (universal — all agents benefit)
    systemPromptBuilder.add("tool-description-guidance", {});

    // Add core agent fragments using shared composition
    t0 = performance.now();
    await addCoreAgentFragments(
        systemPromptBuilder,
        agentForFragments,
        mcpManager,
        parentSpan,
        includeMcpResources
    );
    parentSpan?.addEvent("core_agent_fragments_added", { "duration_ms": Math.round(performance.now() - t0) });

    // Add agent-specific fragments
    const projectDTag = project.dTag || project.tagValue("d") || undefined;
    addAgentFragments(
        systemPromptBuilder,
        agentForFragments,
        availableAgents,
        triggeringEnvelope,
        options.projectManagerPubkey,
        projectDTag,
        options.projectBasePath
    );

    // Build and return the complete prompt with all fragments
    t0 = performance.now();
    const result = await systemPromptBuilder.build();
    parentSpan?.addEvent("fragments_built", { "duration_ms": Math.round(performance.now() - t0), "fragment.count": systemPromptBuilder.getFragmentCount() });
    return result;
}
