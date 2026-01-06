import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { MCPManager } from "@/services/mcp/MCPManager";
import { ReportService } from "@/services/reports";
import { SchedulerService } from "@/services/scheduling";
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
 * Add core agent fragments that are common to both project and standalone modes
 */
async function addCoreAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    conversation?: ConversationStore,
    agentLessons?: Map<string, NDKAgentLesson[]>,
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

    // Add retrieved lessons
    builder.add("retrieved-lessons", {
        agent,
        agentLessons: agentLessons || new Map(),
    });

    // Add memorized reports - retrieved from cache (no async fetch needed)
    try {
        const reportService = new ReportService();
        const memorizedReports = reportService.getMemorizedReports(agent.pubkey);
        if (memorizedReports.length > 0) {
            builder.add("memorized-reports", { reports: memorizedReports });
            logger.debug("📚 Added memorized reports to system prompt (from cache)", {
                agent: agent.name,
                count: memorizedReports.length,
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
        const { logger } = await import("@/utils/logger");
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
 * Builds the main system prompt content
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
    } = options;

    const systemPromptBuilder = new PromptBuilder();

    // Add agent identity - use workingDirectory for "Absolute Path" (where the agent operates)
    systemPromptBuilder.add("agent-identity", {
        agent,
        projectTitle: project.tagValue("title") || "Unknown Project",
        projectOwnerPubkey: project.pubkey,
        workingDirectory,
    });

    // Add alpha mode warning and bug reporting tools guidance
    systemPromptBuilder.add("alpha-mode", { enabled: alphaMode ?? false });

    // Add agent phases awareness if agent has phases defined
    systemPromptBuilder.add("agent-phases", { agent });

    // NOTE: agent-todos is NOT included here - it's injected as a late system message
    // in AgentExecutor.executeStreaming() to ensure it appears at the end of messages

    // Add worktree context if we have the necessary information
    if (workingDirectory && currentBranch && projectBasePath) {
        systemPromptBuilder.add("worktree-context", {
            context: {
                workingDirectory,
                currentBranch,
                projectBasePath,
                agent,
            },
        });
    }

    // Add core agent fragments using shared composition
    await addCoreAgentFragments(systemPromptBuilder, agent, conversation, agentLessons, mcpManager);

    // Add agent-specific fragments
    addAgentFragments(systemPromptBuilder, agent, availableAgents, options.projectManagerPubkey);

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

    // Add alpha mode warning and bug reporting tools guidance
    systemPromptBuilder.add("alpha-mode", { enabled: alphaMode ?? false });

    // Add core agent fragments using shared composition
    await addCoreAgentFragments(systemPromptBuilder, agent, conversation, agentLessons);

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
