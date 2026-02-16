import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { NudgeToolPermissions, NudgeData } from "@/services/nudge";
import type { SkillData } from "@/services/skill";
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
    nudgeContent?: string; // Concatenated content from kind:4201 nudge events (legacy)
    /** Individual nudge data for rendering with titles */
    nudges?: NudgeData[];
    /** Tool permissions extracted from nudge events */
    nudgeToolPermissions?: NudgeToolPermissions;
    /** Concatenated content from kind:4202 skill events (legacy) */
    skillContent?: string;
    /** Individual skill data for rendering with files */
    skills?: SkillData[];
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
    projectManagerPubkey?: string
): void {
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
        alphaMode,
        mcpManager,
        nudgeContent,
        nudges,
        nudgeToolPermissions,
        skillContent,
        skills,
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

    // If PromptCompilerService is available, get effective instructions SYNCHRONOUSLY
    // EAGER COMPILATION: This NEVER blocks - uses cached compiled instructions or falls back to base
    // Compilation happens in the background at project startup
    let effectiveAgentInstructions: string | undefined;
    if (promptCompiler) {
        const lessons = agentLessons?.get(agent.pubkey) || [];
        const baseAgentInstructions = agent.instructions || "";

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

    // Add global system prompt if configured (ordered by fragment priority)
    systemPromptBuilder.add("global-system-prompt", {});

    // Add relay configuration context
    systemPromptBuilder.add("relay-configuration", {});

    // Add active conversations context (currently running agents in the project)
    systemPromptBuilder.add("active-conversations", {
        agent: agentForFragments,
        currentConversationId: conversation.getId(),
        projectId: project.dTag || project.tagValue("d"),
    });

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

    // Add global system prompt if configured (ordered by fragment priority)
    systemPromptBuilder.add("global-system-prompt", {});

    // Add relay configuration context
    systemPromptBuilder.add("relay-configuration", {});

    // Add alpha mode warning and bug reporting tools guidance
    systemPromptBuilder.add("alpha-mode", { enabled: alphaMode ?? false });

    // Add AGENTS.md guidance - always included even in standalone mode
    // Standalone agents don't have project context, so hasRootAgentsMd is always false
    systemPromptBuilder.add("agents-md-guidance", {
        hasRootAgentsMd: false,
        rootAgentsMdContent: undefined,
    });

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
