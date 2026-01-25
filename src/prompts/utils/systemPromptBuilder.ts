import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { MCPManager } from "@/services/mcp/MCPManager";
import { isProjectContextInitialized, getProjectContext } from "@/services/projects";
import type { PromptCompilerService } from "@/services/prompt-compiler";
import { ReportService } from "@/services/reports";
import { SchedulerService } from "@/services/scheduling";
import { formatLessonsWithReminder } from "@/utils/lessonFormatter";
import { logger } from "@/utils/logger";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

// Import fragment registration manifest
import "@/prompts/fragments"; // This auto-registers all fragments

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
    isProjectManager?: boolean; // Indicates if this agent is the PM
    projectManagerPubkey?: string; // Pubkey of the project manager
    alphaMode?: boolean; // True when running in alpha mode
    mcpManager?: MCPManager; // MCP manager for this project
    nudgeContent?: string; // Concatenated content from kind:4201 nudge events
}

export interface BuildStandalonePromptOptions {
    // Required data
    agent: AgentInstance;

    // Optional runtime data
    availableAgents?: AgentInstance[];
    conversation?: ConversationStore;
    agentLessons?: Map<string, NDKAgentLesson[]>;
    projectManagerPubkey?: string; // Pubkey of the project manager
    alphaMode?: boolean; // True when running in alpha mode
}

export interface SystemMessage {
    message: ModelMessage;
    metadata?: {
        description?: string;
    };
}

/**
 * Add lessons to the prompt using the simple fragment approach.
 * Called when PromptCompilerService is NOT available.
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
 * Add core agent fragments that are common to both project and standalone modes.
 * NOTE: Lessons are NOT included here - they are handled separately via either:
 *   1. addLessonsViaFragment() - simple fragment approach
 *   2. compileLessonsIntoPrompt() - PromptCompilerService approach (TIN-10)
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
}

/**
 * Default timeout for waitForEOSE to prevent indefinite blocking.
 * If EOSE doesn't arrive within this time, we proceed without comments.
 */
const EOSE_TIMEOUT_MS = 5000; // 5 seconds

/**
 * Compile lessons into a prompt using PromptCompilerService (TIN-10).
 *
 * This function:
 * 1. Waits for EOSE to ensure all lesson comments are received (with timeout)
 * 2. Calls compile() to synthesize lessons + comments into the base prompt
 * 3. Falls back to simple concatenation if compilation fails
 *
 * Note: The service retrieves lessons internally from ProjectContext.
 *
 * @param compiler The PromptCompilerService for this agent
 * @param lessons The agent's lessons (used for fallback formatting if compilation fails)
 * @param basePrompt The system prompt without lessons
 * @param agentDefinitionEventId Optional event ID for cache hash (for non-local agents)
 * @returns The compiled prompt with lessons integrated
 */
async function compileLessonsIntoPrompt(
    compiler: PromptCompilerService,
    lessons: NDKAgentLesson[],
    basePrompt: string,
    agentDefinitionEventId?: string
): Promise<string> {
    try {
        // Wait for EOSE with timeout to prevent indefinite blocking
        await Promise.race([
            compiler.waitForEOSE(),
            new Promise<void>((_, reject) =>
                setTimeout(
                    () => reject(new Error("EOSE timeout - proceeding without all comments")),
                    EOSE_TIMEOUT_MS
                )
            ),
        ]);
    } catch (eoseError) {
        // Log warning but continue - we can still compile with whatever comments we have
        logger.warn("waitForEOSE issue, proceeding with compilation", {
            error: eoseError instanceof Error ? eoseError.message : String(eoseError),
        });
    }

    try {
        // Compile lessons + comments into the base prompt
        // The service retrieves lessons internally from ProjectContext
        const compiledPrompt = await compiler.compile(basePrompt, agentDefinitionEventId);

        logger.debug("✅ Compiled lessons into prompt using PromptCompilerService", {
            basePromptLength: basePrompt.length,
            compiledPromptLength: compiledPrompt.length,
        });

        return compiledPrompt;
    } catch (error) {
        logger.error("Failed to compile lessons with PromptCompilerService, using fallback", {
            error: error instanceof Error ? error.message : String(error),
        });

        // Fallback to simple concatenation if compilation fails
        return formatFallbackLessons(lessons, basePrompt);
    }
}

/**
 * Fallback lesson formatting: appends formatted lessons to base prompt.
 * Used when PromptCompilerService cannot compile (no LLM config, LLM error, etc.)
 */
function formatFallbackLessons(lessons: NDKAgentLesson[], basePrompt: string): string {
    if (lessons.length === 0) {
        return basePrompt;
    }

    const formattedSection = formatLessonsWithReminder(lessons);
    return `${basePrompt}\n\n${formattedSection}`;
}

/**
 * Add agent-specific fragments
 */
function addAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    availableAgents: AgentInstance[],
    projectManagerPubkey?: string
): void {
    // Add available agents for delegations
    builder.add("available-agents", {
        agents: availableAgents,
        currentAgent: agent,
        projectManagerPubkey,
    });
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
 * Builds the main system prompt content.
 *
 * Uses PromptCompilerService (TIN-10) when available to synthesize lessons + comments
 * into the agent's BASE INSTRUCTIONS ONLY. The compiled result (base instructions + lessons)
 * is then used when building fragments.
 *
 * IMPORTANT: The compiled prompt should contain ONLY:
 * - Agent base instructions (from agent.instructions)
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
        alphaMode,
        mcpManager,
        nudgeContent,
    } = options;

    // Check if PromptCompilerService is available for this agent (TIN-10)
    let promptCompiler: PromptCompilerService | undefined;
    if (isProjectContextInitialized()) {
        try {
            const context = getProjectContext();
            promptCompiler = context.getPromptCompiler(agent.pubkey);
        } catch {
            // Project context not available - will fall back to simple lessons formatting
        }
    }

    const usePromptCompiler = !!promptCompiler;

    // If PromptCompilerService is available, compile lessons into ONLY the base instructions
    // The compiled result replaces agent.instructions for fragment building
    let compiledInstructions: string | undefined;
    if (promptCompiler) {
        const lessons = agentLessons?.get(agent.pubkey) || [];
        // CRITICAL: Pass ONLY agent.instructions (base instructions), NOT the full system prompt
        // This ensures the cache contains only base instructions + lessons, not runtime fragments
        const baseInstructions = agent.instructions || "";
        compiledInstructions = await compileLessonsIntoPrompt(
            promptCompiler,
            lessons,
            baseInstructions,
            agent.eventId
        );

        logger.debug("✅ Compiled lessons into base instructions", {
            agentName: agent.name,
            baseInstructionsLength: baseInstructions.length,
            compiledLength: compiledInstructions.length,
        });
    }

    // Create an agent copy with compiled instructions (if available)
    // This ensures fragments use the compiled version instead of raw instructions
    const agentForFragments: AgentInstance = compiledInstructions
        ? { ...agent, instructions: compiledInstructions }
        : agent;

    const systemPromptBuilder = new PromptBuilder();

    // Add agent identity - use workingDirectory for "Absolute Path" (where the agent operates)
    // NOTE: Uses agentForFragments which has compiled instructions (lessons merged in)
    systemPromptBuilder.add("agent-identity", {
        agent: agentForFragments,
        projectTitle: project.tagValue("title") || "Unknown Project",
        projectOwnerPubkey: project.pubkey,
        workingDirectory,
    });

    // Add agent home directory context
    systemPromptBuilder.add("agent-home-directory", { agent: agentForFragments });

    // Add recent conversations context (short-term memory)
    systemPromptBuilder.add("recent-conversations", {
        agent: agentForFragments,
        currentConversationId: conversation.getId(),
        projectId: project.dTag || project.tagValue("d"),
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
    if (nudgeContent && nudgeContent.trim().length > 0) {
        systemPromptBuilder.add("nudges", { nudgeContent });
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

    // Add core agent fragments using shared composition
    await addCoreAgentFragments(systemPromptBuilder, agentForFragments, conversation, mcpManager);

    // Handle lessons: ONLY add via fragment if NOT using PromptCompilerService
    // When using compiler, lessons are already merged into compiledInstructions
    if (!usePromptCompiler) {
        // No compiler available - add lessons via fragment
        addLessonsViaFragment(systemPromptBuilder, agentForFragments, agentLessons);
    }

    // Add agent-specific fragments
    addAgentFragments(systemPromptBuilder, agentForFragments, availableAgents, options.projectManagerPubkey);

    // Build and return the complete prompt with all fragments
    return systemPromptBuilder.build();
}

/**
 * Builds system prompt messages for standalone agents (without project context).
 * Includes most fragments except project-specific ones.
 */
export async function buildStandaloneSystemPromptMessages(
    options: BuildStandalonePromptOptions
): Promise<SystemMessage[]> {
    const messages: SystemMessage[] = [];

    // Build the main system prompt
    const mainPrompt = await buildStandaloneMainPrompt(options);
    messages.push({
        message: { role: "system", content: mainPrompt },
        metadata: {
            description: "Main standalone system prompt",
        },
    });

    return messages;
}

/**
 * Builds the main system prompt for standalone agents
 */
async function buildStandaloneMainPrompt(options: BuildStandalonePromptOptions): Promise<string> {
    const { agent, availableAgents = [], conversation, agentLessons, alphaMode } = options;

    const systemPromptBuilder = new PromptBuilder();

    // For standalone agents, use a simplified identity without project references
    systemPromptBuilder.add("agent-identity", {
        agent,
        projectTitle: "Standalone Mode",
        projectOwnerPubkey: agent.pubkey, // Use agent's own pubkey as owner
    });

    // Add agent home directory context
    systemPromptBuilder.add("agent-home-directory", { agent });

    // Add alpha mode warning and bug reporting tools guidance
    systemPromptBuilder.add("alpha-mode", { enabled: alphaMode ?? false });

    // Add core agent fragments using shared composition
    await addCoreAgentFragments(systemPromptBuilder, agent, conversation);

    // Add lessons via fragment (standalone mode doesn't use PromptCompilerService)
    addLessonsViaFragment(systemPromptBuilder, agent, agentLessons);

    // Add agent-specific fragments only if multiple agents available
    if (availableAgents.length > 1) {
        addAgentFragments(
            systemPromptBuilder,
            agent,
            availableAgents,
            options.projectManagerPubkey
        );
    }

    return systemPromptBuilder.build();
}
