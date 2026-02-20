import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { NudgeToolPermissions, NudgeData, WhitelistItem } from "@/services/nudge";
import type { SkillData } from "@/services/skill";
import { PromptCompilerService, type LessonComment } from "@/services/prompt-compiler";
import { getNDK } from "@/nostr";
import { config } from "@/services/ConfigService";
import { getProjectContext } from "@/services/projects";
import { ReportService } from "@/services/reports";
import { SchedulerService } from "@/services/scheduling";
import { formatLessonsWithReminder } from "@/utils/lessonFormatter";
import { logger } from "@/utils/logger";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

// Import fragment registration manifest
import "@/prompts/fragments"; // This auto-registers all fragments

/**
 * Module-level cache for PromptCompilerService instances per project+agent.
 * Prevents duplicate LLM calls when multiple system prompt builds occur for the same agent.
 * The cache holds compilers for the process lifetime — memory is bounded by agent count × projects.
 *
 * KEY FORMAT: `${projectCacheKey}:${agentPubkey}` to prevent cross-project contamination
 * when the same agent pubkey is active in multiple concurrent projects.
 */
const promptCompilerCache = new Map<string, PromptCompilerService>();

/**
 * In-flight promise cache to prevent race conditions when multiple concurrent
 * prompt builds try to create compilers simultaneously for the same project+agent.
 * This ensures only one compiler is created per project+agent combination.
 */
const inFlightCompilerPromises = new Map<string, Promise<PromptCompilerService | undefined>>();

/**
 * Set of project IDs that have already emitted a "missing d-tag" warning.
 * Used to implement warn-once behavior and prevent log spam on hot paths.
 */
const warnedMissingDTagProjects = new Set<string>();

/**
 * Apply updates to an existing PromptCompilerService.
 * Adds new comments and updates lessons, triggering recompilation if needed.
 */
function applyCompilerUpdates(
    compiler: PromptCompilerService,
    comments: LessonComment[],
    lessons: NDKAgentLesson[]
): void {
    // Add comments (de-duplicated internally by addComment)
    for (const comment of comments) {
        compiler.addComment(comment);
    }
    // Update lessons - compiler detects staleness and triggers recompilation as needed
    compiler.updateLessons(lessons);
}

/**
 * List of scheduling-related tools that trigger the scheduled tasks context
 */
const SCHEDULING_TOOLS = ["schedule_task", "schedule_task_cancel", "schedule_tasks_list"] as const;

export interface BuildSystemPromptOptions {
    // Required data
    agent: AgentInstance;
    project: NDKProject;
    conversation: ConversationStore;

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
    agentLessons?: Map<string, NDKAgentLesson[]>;
    /** Comments on agent lessons (kind 1111 NIP-22 comments) */
    agentComments?: Map<string, LessonComment[]>;
    isProjectManager?: boolean; // Indicates if this agent is the PM
    projectManagerPubkey?: string; // Pubkey of the project manager
    alphaMode?: boolean; // True when running in alpha mode
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
    /** Available whitelisted nudges for delegation */
    availableNudges?: WhitelistItem[];
}


export interface SystemMessage {
    message: ModelMessage;
    metadata?: {
        description?: string;
    };
}

/**
 * Add lessons to the prompt using the simple fragment approach.
 * Called when PromptCompilerService is not yet ready (still compiling).
 */
function addLessonsViaFragment(
    builder: PromptBuilder,
    agent: AgentInstance,
    agentLessons?: Map<string, NDKAgentLesson[]>
): void {
    builder.add("retrieved-lessons", {
        agent,
        agentLessons: agentLessons || new Map(),
    });
}

/**
 * Add core agent fragments.
 * NOTE: Lessons are NOT included here - they are handled separately via either:
 *   1. addLessonsViaFragment() - fallback when compiler not ready
 *   2. PromptCompilerService (TIN-10) - compiled into Effective Agent Instructions
 */
async function addCoreAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    conversation?: ConversationStore,
    mcpManager?: MCPManager
): Promise<void> {
    // Add referenced article context if present
    if (conversation?.metadata?.referencedArticle) {
        builder.add("referenced-article", conversation.metadata.referencedArticle);
    }

    // Add scheduled tasks context if agent has scheduling tools
    const hasSchedulingTools = agent.tools.some((tool) =>
        SCHEDULING_TOOLS.includes(tool as (typeof SCHEDULING_TOOLS)[number])
    );

    if (hasSchedulingTools) {
        try {
            const schedulerService = SchedulerService.getInstance();
            const allTasks = await schedulerService.getTasks();
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

    // Add memorized reports - retrieved from cache (no async fetch needed)
    // This includes both:
    // 1. Agent-specific memorized reports (memorize=true) - only for the authoring agent
    // 2. Team-memorized reports (memorize_team=true) - for ALL agents in the project
    try {
        const reportService = new ReportService();

        // Get agent's own memorized reports
        const agentMemorizedReports = reportService.getMemorizedReportsForAgent(agent.pubkey);

        // Get team-memorized reports (visible to ALL agents)
        const teamMemorizedReports = reportService.getTeamMemorizedReports();

        // Combine and deduplicate by slug with scope-aware semantics:
        // 1. Team memos ALWAYS take precedence (they must appear for ALL agents)
        // 2. Within each scope (team vs agent), latest publishedAt wins
        // 3. Agent-only reports are only included if no team memo exists with the same slug

        // Step 1: Deduplicate team reports by slug (latest wins within team scope)
        const teamBySlug = new Map<string, typeof teamMemorizedReports[0]>();
        for (const report of teamMemorizedReports) {
            const existing = teamBySlug.get(report.slug);
            if (!existing || (report.publishedAt || 0) > (existing.publishedAt || 0)) {
                teamBySlug.set(report.slug, report);
            }
        }

        // Step 2: Deduplicate agent reports by slug (latest wins within agent scope)
        const agentBySlug = new Map<string, typeof agentMemorizedReports[0]>();
        for (const report of agentMemorizedReports) {
            const existing = agentBySlug.get(report.slug);
            if (!existing || (report.publishedAt || 0) > (existing.publishedAt || 0)) {
                agentBySlug.set(report.slug, report);
            }
        }

        // Step 3: Combine - team memos first, then agent-only (excluding slugs already in team)
        const combinedReports = [
            ...Array.from(teamBySlug.values()),
            ...Array.from(agentBySlug.values()).filter(r => !teamBySlug.has(r.slug)),
        ];

        if (combinedReports.length > 0) {
            builder.add("memorized-reports", { reports: combinedReports });
            logger.debug("📚 Added memorized reports to system prompt (from cache)", {
                agent: agent.name,
                agentReportsCount: agentMemorizedReports.length,
                teamReportsCount: teamMemorizedReports.length,
                totalCount: combinedReports.length,
            });
        }
    } catch (error) {
        // Report service might fail if no project context
        logger.debug("Could not get memorized reports from cache:", error);
    }

    // Add MCP resources if agent has RAG subscription tools and mcpManager is available
    const hasRagSubscriptionTools = agent.tools.includes("rag_subscription_create");

    if (hasRagSubscriptionTools && mcpManager) {
        const runningServers = mcpManager.getRunningServers();

        // Fetch resources from all running servers
        const resourcesPerServer = await Promise.all(
            runningServers.map(async (serverName: string) => {
                try {
                    const [resources, templates] = await Promise.all([
                        mcpManager.listResources(serverName),
                        mcpManager.listResourceTemplates(serverName),
                    ]);
                    logger.debug(
                        `Fetched ${resources.length} resources and ${templates.length} templates from '${serverName}'`
                    );
                    return { serverName, resources, templates };
                } catch (error) {
                    logger.warn(`Failed to fetch MCP resources from '${serverName}':`, error);
                    // Return empty resources if server fails
                    return { serverName, resources: [], templates: [] };
                }
            })
        );

        builder.add("mcp-resources", {
            agentPubkey: agent.pubkey,
            mcpEnabled: true,
            resourcesPerServer,
        });
    }

    // Add RAG collection attribution - shows agents their contributions to RAG collections
    // This uses the provenance tracking metadata (agent_pubkey) from document ingestion
    //
    // OPTIMIZATION: First check if any collections exist using lightweight check
    // to avoid initializing embedding provider when RAG isn't used.
    try {
        const { hasRagCollections, RAGService } = await import("@/services/rag/RAGService");

        // Fast path: skip full initialization if no collections exist
        // Note: hasRagCollections() returns false on errors and logs them internally
        if (!(await hasRagCollections())) {
            logger.debug("📊 Skipping RAG collection stats - no collections available");
        } else {
            // Collections exist - now we need full service for stats
            const ragService = RAGService.getInstance();
            const collections = await ragService.getAllCollectionStats(agent.pubkey);

            // Only add the fragment if we have any collection data
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
        }
    } catch (error) {
        // RAG service might not be available - skip gracefully
        logger.debug("Could not fetch RAG collection stats for prompt:", error);
    }
}

/**
 * Get Effective Agent Instructions SYNCHRONOUSLY using PromptCompilerService (TIN-10).
 *
 * EAGER COMPILATION: This function NEVER blocks on compilation.
 * - If compiled instructions are available (from cache or completed compilation), use them
 * - If compilation isn't ready yet (in progress or not started), use base instructions
 *
 * Compilation is triggered at project startup and runs in the background.
 * Agent execution always gets the "current best" instructions without waiting.
 *
 * @param compiler The PromptCompilerService for this agent
 * @param lessons The agent's lessons (used for fallback formatting if needed)
 * @param baseAgentInstructions The Base Agent Instructions (from agent.instructions)
 * @returns The Effective Agent Instructions (compiled if available, base otherwise)
 */
function getEffectiveInstructionsSync(
    compiler: PromptCompilerService,
    lessons: NDKAgentLesson[],
    baseAgentInstructions: string
): string {
    // Use the synchronous method - NEVER blocks on compilation
    const result = compiler.getEffectiveInstructionsSync();

    // No span needed here - this is called every RAL and the info is available
    // on the parent agent.execute span or in logs. The instructions_source span
    // was creating 18+ spans per conversation with no debugging value.

    logger.debug("📋 Retrieved effective instructions synchronously", {
        source: result.source,
        isCompiled: result.isCompiled,
        compiledAt: result.compiledAt,
        instructionsLength: result.instructions.length,
    });

    // If we got compiled instructions, use them
    if (result.isCompiled) {
        return result.instructions;
    }

    // Not compiled yet - check if we have lessons to format as fallback
    // This provides a better experience than raw base instructions when lessons exist
    if (lessons.length > 0) {
        logger.debug("📋 Using fallback lesson formatting (compilation not ready)", {
            lessonsCount: lessons.length,
            compilationStatus: result.source,
        });
        return formatFallbackLessons(lessons, baseAgentInstructions);
    }

    // No lessons and no compiled instructions - just use base
    return baseAgentInstructions;
}

/**
 * Fallback lesson formatting: appends formatted lessons to Base Agent Instructions.
 * Used when PromptCompilerService cannot compile (no LLM config, LLM error, etc.)
 */
function formatFallbackLessons(lessons: NDKAgentLesson[], baseAgentInstructions: string): string {
    if (lessons.length === 0) {
        return baseAgentInstructions;
    }

    const formattedSection = formatLessonsWithReminder(lessons);
    return `${baseAgentInstructions}\n\n${formattedSection}`;
}

/**
 * Add agent-specific fragments
 */
function addAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    availableAgents: AgentInstance[],
    projectManagerPubkey?: string,
    availableNudges?: WhitelistItem[]
): void {
    // Add available nudges for delegation (priority 13, before available-agents)
    if (availableNudges && availableNudges.length > 0) {
        builder.add("available-nudges", {
            availableNudges,
        });
    }

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
    const mainPrompt = await buildMainSystemPrompt(options);
    messages.push({
        message: { role: "system", content: mainPrompt },
        metadata: {
            description: "Main system prompt",
        },
    });

    return messages;
}

/**
 * Get or create a PromptCompilerService instance for an agent within a specific project.
 *
 * Uses a module-level cache to avoid duplicate LLM calls when multiple system prompt
 * builds occur for the same agent (e.g., across multiple RALs or conversations).
 *
 * This is the "lazy/on-demand instantiation" pattern:
 * - Returns cached compiler if available for this project+agent combination
 * - Creates new compiler on cache miss: reads disk cache, triggers background compilation
 * - Returns undefined if NDK is unavailable (fallback to simple lesson fragment)
 *
 * IMPORTANT: Cache is scoped by project cache key + agent pubkey to prevent cross-project
 * contamination when the same agent is active in multiple concurrent projects.
 *
 * @param projectCacheKey Cache key prefix for the project (typically dTag, but may be event ID or fallback value if dTag is missing)
 * @param agentPubkey Agent's public key (used as cache key suffix)
 * @param baseAgentInstructions The Base Agent Instructions from agent.instructions
 * @param agentEventId Optional event ID for the agent definition
 * @param lessons Current lessons for this agent
 * @param comments Current comments for this agent's lessons
 * @param agentSigner Optional signer for kind:0 publishing
 * @param agentName Optional agent name for kind:0 publishing
 * @param agentRole Optional agent role for kind:0 publishing
 * @param projectTitle Optional project title for kind:0 publishing
 */
async function getOrCreatePromptCompiler(
    projectCacheKey: string,
    agentPubkey: string,
    baseAgentInstructions: string,
    agentEventId: string | undefined,
    lessons: NDKAgentLesson[],
    comments: LessonComment[],
    agentSigner?: import("@nostr-dev-kit/ndk").NDKPrivateKeySigner,
    agentName?: string,
    agentRole?: string,
    projectTitle?: string
): Promise<PromptCompilerService | undefined> {
    // Build cache key scoped by project + agent to prevent cross-project contamination
    const cacheKey = `${projectCacheKey}:${agentPubkey}`;

    // Check cache first
    const cachedCompiler = promptCompilerCache.get(cacheKey);
    if (cachedCompiler) {
        // Update with any new comments/lessons that arrived since last call
        applyCompilerUpdates(cachedCompiler, comments, lessons);

        logger.debug("📋 Using cached PromptCompilerService", {
            projectCacheKey,
            agentPubkey: agentPubkey.substring(0, 8),
            lessonsCount: lessons.length,
            commentsCount: comments.length,
        });

        return cachedCompiler;
    }

    // Check if there's an in-flight creation for this project+agent (race condition guard)
    const inFlightPromise = inFlightCompilerPromises.get(cacheKey);
    if (inFlightPromise) {
        logger.debug("📋 Waiting for in-flight compiler creation", {
            projectCacheKey,
            agentPubkey: agentPubkey.substring(0, 8),
        });
        // Await the in-flight promise, then apply this caller's comments/lessons
        // to ensure concurrent callers' data is not silently lost
        const compiler = await inFlightPromise;
        if (compiler) {
            applyCompilerUpdates(compiler, comments, lessons);
        }
        return compiler;
    }

    // Create new compiler with single-flight guard
    const creationPromise = (async (): Promise<PromptCompilerService | undefined> => {
        try {
            const ndk = getNDK();
            const { config: loadedConfig } = await config.loadConfig();
            const whitelistArray = loadedConfig.whitelistedPubkeys ?? [];

            const compiler = new PromptCompilerService(agentPubkey, whitelistArray, ndk);

            // Set agent metadata for kind:0 publishing (gap 2 fix)
            // This enables the compiler to publish kind:0 events with compiled instructions
            if (agentSigner && agentName && projectTitle) {
                compiler.setAgentMetadata(agentSigner, agentName, agentRole || "", projectTitle);
            }

            // Load pre-existing comments from ProjectContext
            // This restores comment state that was accumulated by Daemon's handleLessonCommentEvent
            for (const comment of comments) {
                compiler.addComment(comment);
            }

            // Initialize: loads disk cache into memory and stores base instructions + lessons
            await compiler.initialize(baseAgentInstructions, lessons, agentEventId);

            // Trigger background compilation (fire and forget) — no-op if cache is fresh
            compiler.triggerCompilation();

            // Cache for future calls (using project-scoped key)
            promptCompilerCache.set(cacheKey, compiler);

            logger.debug("📋 Created and cached new PromptCompilerService", {
                projectCacheKey,
                agentPubkey: agentPubkey.substring(0, 8),
                lessonsCount: lessons.length,
                commentsCount: comments.length,
            });

            return compiler;
        } catch (error) {
            logger.debug("Could not create lazy PromptCompilerService:", error);
            return undefined;
        } finally {
            // Remove from in-flight map once complete (success or failure)
            inFlightCompilerPromises.delete(cacheKey);
        }
    })();

    // Register in-flight promise to prevent duplicate concurrent creations
    inFlightCompilerPromises.set(cacheKey, creationPromise);

    return creationPromise;
}

/**
 * Builds the main system prompt content.
 *
 * Uses PromptCompilerService (TIN-10) when available to synthesize lessons + comments
 * into Effective Agent Instructions. The result (Base Agent Instructions + Lessons)
 * is then used when building fragments.
 *
 * IMPORTANT: The Effective Agent Instructions should contain ONLY:
 * - Base Agent Instructions (from agent.instructions in Kind 4199 event)
 * - Lessons learned (merged by LLM)
 *
 * Fragments (project context, worktrees, available agents, etc.) are added AFTER compilation.
 */
async function buildMainSystemPrompt(options: BuildSystemPromptOptions): Promise<string> {
    const {
        agent,
        project,
        projectBasePath,
        workingDirectory,
        currentBranch,
        availableAgents = [],
        conversation,
        agentLessons,
        agentComments,
        alphaMode,
        mcpManager,
        nudgeContent,
        nudges,
        nudgeToolPermissions,
        skillContent,
        skills,
    } = options;

    // Lazily instantiate PromptCompilerService for this agent (TIN-10).
    // Reads from disk cache as fast path; triggers LLM compilation in background on cache miss.
    const lessons = agentLessons?.get(agent.pubkey) || [];
    const comments = agentComments?.get(agent.pubkey) || [];
    const baseAgentInstructions = agent.instructions || "";

    // Get project context and agent for kind:0 metadata
    const context = getProjectContext();
    const projectTitle = project.tagValue("title") || "Untitled";
    const agentInstance = context.getAgentByPubkey(agent.pubkey);
    // Use project's dTag for cache key scoping. Fall back to event ID if no dTag to avoid
    // cross-project collisions (using a generic "unknown" string would cause collisions).
    const dTag = project.dTag || project.tagValue("d");
    let projectCacheKey: string;
    if (dTag) {
        projectCacheKey = dTag;
    } else {
        // Warn once per project to avoid log spam on hot path
        const projectIdentifier = project.id || project.pubkey || "unknown";
        if (!warnedMissingDTagProjects.has(projectIdentifier)) {
            warnedMissingDTagProjects.add(projectIdentifier);
            logger.warn("⚠️ Project missing d-tag, using event ID for cache key. This may indicate a misconfigured project.", {
                projectId: project.id?.substring(0, 8),
                projectPubkey: project.pubkey?.substring(0, 8),
            });
        }
        projectCacheKey = project.id || `fallback-${project.pubkey?.substring(0, 16) || "unknown"}`;
    }

    const promptCompiler = await getOrCreatePromptCompiler(
        projectCacheKey,
        agent.pubkey,
        baseAgentInstructions,
        agent.eventId,
        lessons,
        comments,
        // Pass agent metadata for kind:0 publishing (gap 2 fix)
        agentInstance?.signer,
        agentInstance?.name ?? agent.name,
        agentInstance?.role ?? "",
        projectTitle
    );
    const usePromptCompiler = !!promptCompiler;

    // If PromptCompilerService is available, get effective instructions SYNCHRONOUSLY
    // EAGER COMPILATION: This NEVER blocks - uses cached compiled instructions or falls back to base
    let effectiveAgentInstructions: string | undefined;
    if (promptCompiler) {
        // SYNCHRONOUS retrieval - NEVER waits for compilation
        effectiveAgentInstructions = getEffectiveInstructionsSync(
            promptCompiler,
            lessons,
            baseAgentInstructions
        );

        logger.debug("✅ Retrieved Effective Agent Instructions (sync)", {
            agentName: agent.name,
            baseInstructionsLength: baseAgentInstructions.length,
            effectiveInstructionsLength: effectiveAgentInstructions.length,
        });
    }

    // Create an agent copy with Effective Agent Instructions (if available)
    // This ensures fragments use the compiled version instead of raw Base Agent Instructions
    const agentForFragments: AgentInstance = effectiveAgentInstructions
        ? { ...agent, instructions: effectiveAgentInstructions }
        : agent;

    const systemPromptBuilder = new PromptBuilder();

    // Add agent identity - use workingDirectory for "Absolute Path" (where the agent operates)
    // NOTE: Uses agentForFragments which has Effective Agent Instructions (lessons merged in)
    systemPromptBuilder.add("agent-identity", {
        agent: agentForFragments,
        projectTitle: project.tagValue("title") || "Unknown Project",
        projectOwnerPubkey: project.pubkey,
        workingDirectory,
    });

    // Add agent home directory context
    systemPromptBuilder.add("agent-home-directory", { agent: agentForFragments });

    // Explain <system-reminder> tags before agents encounter them
    systemPromptBuilder.add("system-reminders-explanation", {});

    // Add global system prompt if configured (ordered by fragment priority)
    systemPromptBuilder.add("global-system-prompt", {});

    // Add relay configuration context
    systemPromptBuilder.add("relay-configuration", {});

    // Add active conversations context (currently running agents in the project)
    // NOTE: Use project.tagId() (NIP-33 address: "31933:<pubkey>:<d-tag>") for RALRegistry lookups
    // RALRegistry stores entries using tagId(), so lookups must use the same format
    systemPromptBuilder.add("active-conversations", {
        agent: agentForFragments,
        currentConversationId: conversation.getId(),
        projectId: project.tagId(),
    });

    // Add recent conversations context (short-term memory)
    // NOTE: Use project.tagId() for ConversationStore lookups (directory structure uses full tagId)
    systemPromptBuilder.add("recent-conversations", {
        agent: agentForFragments,
        currentConversationId: conversation.getId(),
        projectId: project.tagId(),
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

    // Add alpha mode warning and bug reporting tools guidance
    systemPromptBuilder.add("alpha-mode", { enabled: alphaMode ?? false });

    // Add nudge content if present (from kind:4201 events referenced by the triggering event)
    // Now supports individual nudge data with tool permissions
    if ((nudges && nudges.length > 0) || (nudgeContent && nudgeContent.trim().length > 0)) {
        systemPromptBuilder.add("nudges", {
            nudgeContent,
            nudges,
            nudgeToolPermissions,
        });
    }

    // Add skill content if present (from kind:4202 events referenced by the triggering event)
    // Skills provide transient capabilities and attached files, but do NOT modify tool permissions
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
            const { agentsMdService } = await import("@/services/agents-md");
            const hasRootAgentsMd = await agentsMdService.hasRootAgentsMd(projectBasePath);
            const rootContent = hasRootAgentsMd
                ? await agentsMdService.getRootAgentsMdContent(projectBasePath)
                : null;
            systemPromptBuilder.add("agents-md-guidance", {
                hasRootAgentsMd,
                rootAgentsMdContent: rootContent || undefined,
            });
        } catch (error) {
            // AGENTS.md service not available or error - add fragment with no AGENTS.md state
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

    // Add core agent fragments using shared composition
    await addCoreAgentFragments(systemPromptBuilder, agentForFragments, conversation, mcpManager);

    // Handle lessons: ONLY add via fragment if NOT using PromptCompilerService
    // When using compiler, lessons are already merged into Effective Agent Instructions
    if (!usePromptCompiler) {
        // No compiler available - add lessons via fragment
        addLessonsViaFragment(systemPromptBuilder, agentForFragments, agentLessons);
    }

    // Add agent-specific fragments
    addAgentFragments(
        systemPromptBuilder,
        agentForFragments,
        availableAgents,
        options.projectManagerPubkey,
        options.availableNudges
    );

    // Build and return the complete prompt with all fragments
    return systemPromptBuilder.build();
}

