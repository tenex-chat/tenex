// Status publishing interval
const STATUS_INTERVAL_MS = 30_000; // 30 seconds

import { DELEGATE_TOOLS, CORE_AGENT_TOOLS, CONTEXT_INJECTED_TOOLS } from "@/agents/constants";
import type { ScheduledTaskInfo, StatusIntent } from "@/nostr/types";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { type ProjectContext, projectContextStore } from "@/services/projects";
import { getAllToolNames } from "@/tools/registry";
import type { ToolName } from "@/tools/types";
import { SchedulerService } from "@/services/scheduling/SchedulerService";
import { formatAnyError } from "@/lib/error-formatter";
import { getDefaultBranchName } from "@/utils/git/initializeGitRepo";
import { listWorktrees } from "@/utils/git/worktree";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { join } from "path";

/**
 * StatusPublisher handles periodic publishing of status events to Nostr.
 *
 * This class manages the lifecycle of status event publishing, including:
 * - Starting and stopping the periodic publishing interval
 * - Creating and publishing status events with agent and model information
 * - Handling errors gracefully to ensure the main process continues
 *
 * Status events are published at regular intervals (STATUS_INTERVAL_MS) and include:
 * - Project reference tags
 * - Agent pubkeys and slugs
 * - Model configurations
 *
 * @example
 * ```typescript
 * const service = new ProjectStatusService();
 * await service.startPublishing('/path/to/project', projectContext);
 * // ... later
 * service.stopPublishing();
 * ```
 */
export class ProjectStatusService {
    private statusInterval?: NodeJS.Timeout;
    private projectContext!: ProjectContext;

    async startPublishing(projectPath: string, projectContext: ProjectContext): Promise<void> {
        // Store the project context (required for daemon mode)
        this.projectContext = projectContext;

        await this.publishStatusEvent(projectPath);

        this.statusInterval = setInterval(async () => {
            // Wrap the publish in AsyncLocalStorage to ensure context is available
            await projectContextStore.run(this.projectContext, async () => {
                await this.publishStatusEvent(projectPath);
            });
        }, STATUS_INTERVAL_MS);
    }

    stopPublishing(): void {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = undefined;
        }
    }

    /**
     * Publish a status event immediately.
     * Use this after agent configuration changes to immediately reflect the new state.
     */
    async publishImmediately(): Promise<void> {
        if (!this.projectContext) {
            logger.warn("Cannot publish immediately - no project context available");
            return;
        }

        // Get project path from context
        const projectPath = this.projectContext.project.tagValue("d");
        if (!projectPath) {
            logger.warn("Cannot publish immediately - no project path available");
            return;
        }

        // Get the actual project base path from config
        const projectBasePath = join(config.getProjectsBase(), projectPath);

        await projectContextStore.run(this.projectContext, async () => {
            await this.publishStatusEvent(projectBasePath);
        });

        logger.debug("Published status event immediately after config change");
    }

    /**
     * Create a status event from the intent.
     * Directly creates the event without depending on AgentPublisher.
     */
    private createStatusEvent(intent: StatusIntent): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.TenexProjectStatus;
        event.content = "";

        // Use stored context (this.projectContext is always set when publishing)
        const projectCtx = this.projectContext;

        // Add project tag
        event.tag(projectCtx.project.tagReference());

        // Add p-tag for the project owner's pubkey
        event.tag(["p", projectCtx.project.pubkey]);

        // Track unique agent slugs for single-letter tags
        const uniqueAgentSlugs = new Set<string>();

        // Add agent pubkeys with PM flag for project manager
        const pmPubkey = projectCtx.projectManager?.pubkey;
        for (const agent of intent.agents) {
            const tags = ["agent", agent.pubkey, agent.slug];
            // Add "pm" flag if this is the project manager
            if (pmPubkey && agent.pubkey === pmPubkey) {
                tags.push("pm");
            }
            event.tag(tags);

            // Collect unique agent slugs
            uniqueAgentSlugs.add(agent.slug);
        }

        // Add model access tags
        for (const model of intent.models) {
            event.tag(["model", model.slug, ...model.agents]);

            // Collect agent slugs from models
            for (const agentSlug of model.agents) {
                uniqueAgentSlugs.add(agentSlug);
            }
        }

        // Add tool access tags
        for (const tool of intent.tools) {
            event.tag(["tool", tool.name, ...tool.agents]);
        }

        // Add worktree tags (default branch first)
        if (intent.worktrees && intent.worktrees.length > 0) {
            for (const branchName of intent.worktrees) {
                event.tag(["branch", branchName]);
            }
        }

        // Add scheduled task tags
        // Format: ["scheduled-task", id, title, schedule, targetAgentSlug, type, lastRunTimestamp]
        if (intent.scheduledTasks && intent.scheduledTasks.length > 0) {
            for (const task of intent.scheduledTasks) {
                event.tag([
                    "scheduled-task",
                    task.id,
                    task.title,
                    task.schedule,
                    task.targetAgentSlug,
                    task.type,
                    task.lastRun ? String(task.lastRun) : "",
                ]);
            }
        }

        return event;
    }

    private async publishStatusEvent(projectPath: string): Promise<void> {
        try {
            // Use stored context (this.projectContext is always set when publishing)
            const projectCtx = this.projectContext;

            // Build status intent
            const intent: StatusIntent = {
                type: "status",
                agents: [],
                models: [],
                tools: [],
            };

            // Gather agent info - preserve order from NDKProject
            {
                // Get agent tags from project in their original order
                const projectAgentTags = projectCtx.project.tags.filter(
                    (tag) => tag[0] === "agent" && tag[1]
                );

                // Track which agents we've already added (by slug)
                const addedAgentSlugs = new Set<string>();

                // First, add agents that have eventIds in the order they appear in the project
                for (const agentTag of projectAgentTags) {
                    const eventId = agentTag[1];

                    // Find agent with matching eventId
                    for (const [agentSlug, agent] of projectCtx.agentRegistry.getAllAgentsMap()) {
                        if (agent.eventId === eventId) {
                            intent.agents.push({
                                pubkey: agent.pubkey,
                                slug: agentSlug,
                            });
                            addedAgentSlugs.add(agentSlug);
                            break;
                        }
                    }
                }

                // Then add any remaining agents (global or inline agents without eventIds)
                for (const [agentSlug, agent] of projectCtx.agentRegistry.getAllAgentsMap()) {
                    if (!addedAgentSlugs.has(agentSlug)) {
                        intent.agents.push({
                            pubkey: agent.pubkey,
                            slug: agentSlug,
                        });
                    }
                }
            }

            // Gather model info
            await this.gatherModelInfo(intent);

            // Gather tool info
            await this.gatherToolInfo(intent);

            // Gather worktree info
            await this.gatherWorktreeInfo(intent, projectPath);

            // Gather scheduled task info
            await this.gatherScheduledTaskInfo(intent);

            // Create and publish the status event directly
            const event = this.createStatusEvent(intent);

            // Sign and publish with TENEX backend private key
            try {
                const backendPrivateKey = await config.ensureBackendPrivateKey();
                const backendSigner = new NDKPrivateKeySigner(backendPrivateKey);

                await event.sign(backendSigner, { pTags: false });
                await event.publish();
            } catch (error) {
                logger.error("Failed to sign and publish status event", {
                    error: formatAnyError(error),
                });
            }
        } catch (err) {
            const errorMessage = formatAnyError(err);
            logger.warn(`Failed to publish status event: ${errorMessage}`);
        }
    }

    private async gatherModelInfo(intent: StatusIntent): Promise<void> {
        try {
            const { llms } = await config.loadConfig();

            if (!llms || !llms.configurations) {
                logger.debug("No LLM configurations found");
                return;
            }

            // Build a map of configuration slugs to agents that use them
            const configToAgents = new Map<string, Set<string>>();

            // First, add ALL configured models (even if not used by any agent)
            for (const configSlug of Object.keys(llms.configurations)) {
                configToAgents.set(configSlug, new Set());
            }

            logger.debug(`Found ${Object.keys(llms.configurations).length} LLM configurations`);
            logger.debug(`Global default configuration: ${llms.default || "none"}`);

            // Process agent-specific configurations
            if (this.projectContext) {
                const projectCtx = this.projectContext;

                // Get the global default configuration name
                const globalDefault = llms.default;

                // Map each agent to its configuration
                const agentsList = Array.from(projectCtx.agentRegistry.getAllAgentsMap().keys());
                logger.debug(
                    `Mapping ${agentsList.length} agents to configurations: ${agentsList.join(", ")}`
                );

                for (const [agentSlug, agent] of projectCtx.agentRegistry.getAllAgentsMap()) {
                    // Check if agent has a specific llmConfig
                    const agentConfig = agent.llmConfig;

                    if (agentConfig && llms.configurations[agentConfig]) {
                        // Agent has a specific configuration that exists
                        configToAgents.get(agentConfig)?.add(agentSlug);
                        logger.debug(
                            `Agent '${agentSlug}' mapped to specific configuration '${agentConfig}'`
                        );
                    } else if (globalDefault && llms.configurations[globalDefault]) {
                        // Fall back to global default configuration
                        configToAgents.get(globalDefault)?.add(agentSlug);
                        logger.debug(
                            `Agent '${agentSlug}' mapped to default configuration '${globalDefault}'`
                        );
                    } else {
                        logger.debug(
                            `Agent '${agentSlug}' not mapped - no valid configuration found (agent config: ${agentConfig}, default: ${globalDefault})`
                        );
                    }
                }
            }

            // Add models to intent
            for (const [configSlug, agentSet] of configToAgents) {
                const agentSlugs = Array.from(agentSet).sort(); // Sort for consistency
                logger.debug(
                    `Configuration '${configSlug}' has ${agentSlugs.length} agents: ${agentSlugs.join(", ")}`
                );
                intent.models.push({
                    slug: configSlug,
                    agents: agentSlugs,
                });
            }
        } catch (err) {
            logger.warn(
                `Could not load LLM information for status event model tags: ${formatAnyError(err)}`
            );
        }
    }

    private async gatherToolInfo(intent: StatusIntent): Promise<void> {
        try {
            if (!this.projectContext) {
                logger.warn("ProjectContext not initialized for tool tags");
                return;
            }

            const projectCtx = this.projectContext;
            const toolAgentMap = new Map<string, Set<string>>();

            // First, add ALL tool names from the registry (except excluded tools)
            const allToolNames = getAllToolNames();
            for (const toolName of allToolNames) {
                // Skip delegate tools, core tools, and context-injected tools from TenexProjectStatus events
                // These are handled automatically by the system and not configurable per-agent
                if (
                    !DELEGATE_TOOLS.includes(toolName) &&
                    !CORE_AGENT_TOOLS.includes(toolName) &&
                    !CONTEXT_INJECTED_TOOLS.includes(toolName)
                ) {
                    toolAgentMap.set(toolName, new Set());
                }
            }

            // Add all MCP tools from running servers (with empty agent sets initially)
            // Agents will be added to their MCP tools in the loop below
            // Note: mcp__tenex__* tools are filtered out - these are internal TENEX tools
            // wrapped through MCP and should not be announced in status events
            // We also track valid MCP tools to filter agent definitions later
            const validMcpToolNames = new Set<string>();
            if (projectCtx.mcpManager) {
                try {
                    const mcpTools = projectCtx.mcpManager.getCachedTools();
                    for (const toolName of Object.keys(mcpTools)) {
                        // Filter out mcp__tenex__* tools - internal TENEX MCP wrapper tools
                        if (toolName && !toolName.startsWith("mcp__tenex__")) {
                            validMcpToolNames.add(toolName);
                            if (!toolAgentMap.has(toolName)) {
                                toolAgentMap.set(toolName, new Set());
                            }
                        }
                    }
                } catch {
                    // MCP tools might not be available yet, that's okay
                }
            }

            // Then build a map of tool name -> set of agent slugs that have access
            for (const [agentSlug, agent] of projectCtx.agentRegistry.getAllAgentsMap()) {
                // Get the agent's configured tools
                const agentTools = agent.tools || [];

                for (const toolName of agentTools) {
                    // Skip invalid tool names
                    if (!toolName) {
                        logger.warn(`Agent ${agentSlug} has invalid tool name: ${toolName}`);
                        continue;
                    }
                    // Skip delegate tools, core tools, and context-injected tools - they're not included in TenexProjectStatus events
                    // These are handled automatically by the system
                    if (
                        DELEGATE_TOOLS.includes(toolName as ToolName) ||
                        CORE_AGENT_TOOLS.includes(toolName as ToolName) ||
                        CONTEXT_INJECTED_TOOLS.includes(toolName as ToolName)
                    ) {
                        continue;
                    }
                    // For MCP tools, only include if they exist in running MCP servers
                    // This prevents announcing MCP tools in agent definitions that aren't actually available
                    // Note: mcp__tenex__* tools are already excluded from validMcpToolNames
                    if (toolName.startsWith("mcp__") && !validMcpToolNames.has(toolName)) {
                        continue;
                    }
                    const toolAgents = toolAgentMap.get(toolName);
                    if (toolAgents) {
                        toolAgents.add(agentSlug);
                    }
                }
            }

            // Convert the map to tool entries
            // Include ALL tools with valid names, even if no agents are assigned
            for (const [toolName, agentSlugs] of toolAgentMap) {
                if (toolName) {
                    const agentArray = Array.from(agentSlugs).sort(); // Sort for consistency
                    intent.tools.push({
                        name: toolName,
                        agents: agentArray, // Can be empty array for unassigned tools
                    });
                }
            }
        } catch (err) {
            logger.warn(`Could not add tool tags to status event: ${formatAnyError(err)}`);
        }
    }

    private async gatherWorktreeInfo(intent: StatusIntent, projectPath: string): Promise<void> {
        try {
            // Get all worktrees
            const worktrees = await listWorktrees(projectPath);

            if (worktrees.length === 0) {
                logger.debug("No worktrees found for project", { projectPath });
                return;
            }

            // Get the default branch name (current branch of main worktree)
            const defaultBranch = await getDefaultBranchName(projectPath);

            // Build worktree list with default branch first
            const worktreeList: string[] = [];

            // Find and add default branch first
            const defaultWorktree = worktrees.find((wt) => wt.branch === defaultBranch);
            if (defaultWorktree) {
                worktreeList.push(defaultWorktree.branch);
            }

            // Add remaining worktrees sorted alphabetically
            const remainingWorktrees = worktrees
                .filter((wt) => wt.branch !== defaultBranch)
                .map((wt) => wt.branch)
                .sort();

            worktreeList.push(...remainingWorktrees);

            logger.debug("Gathered worktrees for status", {
                total: worktreeList.length,
                default: defaultBranch,
                worktrees: worktreeList,
            });

            intent.worktrees = worktreeList;
        } catch (err) {
            logger.warn(`Could not gather worktree information: ${formatAnyError(err)}`);
        }
    }

    private async gatherScheduledTaskInfo(intent: StatusIntent): Promise<void> {
        try {
            const projectCtx = this.projectContext;
            const projectTagId = projectCtx.project.tagId();

            if (!projectTagId) {
                logger.debug("No project tagId available for scheduled task gathering");
                return;
            }

            const scheduler = SchedulerService.getInstance();
            const tasks = await scheduler.getTasks(projectTagId);

            if (tasks.length === 0) {
                logger.debug("No scheduled tasks for project", { projectTagId });
                return;
            }

            // Build a pubkey-to-slug map from agents for resolving toPubkey
            const pubkeyToSlug = new Map<string, string>();
            for (const [slug, agent] of projectCtx.agentRegistry.getAllAgentsMap()) {
                pubkeyToSlug.set(agent.pubkey, slug);
            }

            const scheduledTasks: ScheduledTaskInfo[] = [];

            for (const task of tasks) {
                const targetSlug = pubkeyToSlug.get(task.toPubkey) || task.toPubkey.substring(0, 8);
                const lastRunTimestamp = task.lastRun
                    ? Math.floor(new Date(task.lastRun).getTime() / 1000)
                    : undefined;

                scheduledTasks.push({
                    id: task.id,
                    title: task.title || task.prompt.substring(0, 50),
                    schedule: task.schedule,
                    targetAgentSlug: targetSlug,
                    type: task.type || "cron",
                    lastRun: lastRunTimestamp,
                });
            }

            intent.scheduledTasks = scheduledTasks;

            logger.debug("Gathered scheduled tasks for status", {
                total: scheduledTasks.length,
                projectTagId,
            });
        } catch (err) {
            logger.warn(`Could not gather scheduled task information: ${formatAnyError(err)}`);
        }
    }
}
