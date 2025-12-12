import * as fs from "node:fs/promises";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { ConversationCoordinator } from "@/conversations";
import { EventHandler } from "@/event-handler";
import { NDKMCPTool } from "@/events/NDKMCPTool";
import { LLMLogger } from "@/logging/LLMLogger";
import { getNDK } from "@/nostr";
import { ProjectContext } from "@/services/ProjectContext";
import { projectContextStore } from "@/services/ProjectContextStore";
import { mcpService } from "@/services/mcp/MCPManager";
import { installMCPServerFromEvent } from "@/services/mcp/mcpInstaller";
import { ProjectStatusService } from "@/services/status/ProjectStatusService";
import { cloneGitRepository, initializeGitRepository } from "@/utils/git";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import chalk from "chalk";

/**
 * Self-contained runtime for a single project.
 * Manages its own lifecycle, status publishing, and event handling.
 */
export class ProjectRuntime {
    public readonly projectId: string;
    public projectPath: string; // User's git repo path (updated after git initialization)
    private readonly metadataPath: string; // TENEX metadata path
    private readonly dTag: string;

    private project: NDKProject;
    private context: ProjectContext | null = null;
    private eventHandler: EventHandler | null = null;
    private statusPublisher: ProjectStatusService | null = null;
    private conversationCoordinator: ConversationCoordinator | null = null;

    private isRunning = false;
    private startTime: Date | null = null;
    private lastEventTime: Date | null = null;
    private eventCount = 0;

    constructor(project: NDKProject, projectsBase: string) {
        this.project = project;

        // Build project ID: "31933:authorPubkey:dTag"
        const dTag = project.tagValue("d");
        if (!dTag) {
            throw new Error("Project missing required d tag");
        }
        this.dTag = dTag;
        this.projectId = `31933:${project.pubkey}:${dTag}`;

        // User's git repository base: {projectsBase}/{dTag}
        // (The actual repo will be at {projectsBase}/{dTag}/{branchName} after initialization)
        this.projectPath = path.join(projectsBase, dTag);

        // TENEX metadata (hidden): ~/.tenex/projects/{dTag}
        this.metadataPath = path.join(config.getConfigPath("projects"), dTag);
    }

    /**
     * Start the project runtime
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn(`Project runtime already running: ${this.projectId}`);
            return;
        }

        const projectTitle = this.project.tagValue("title") || "Untitled";
        console.log(chalk.yellow(`🚀 Starting project: ${chalk.bold(projectTitle)}`));

        logger.info(`Starting project runtime: ${this.projectId}`, {
            title: this.project.tagValue("title"),
        });

        try {
            // Create TENEX metadata directories: ~/.tenex/projects/<dTag>/{conversations,logs}
            await fs.mkdir(path.join(this.metadataPath, "conversations"), { recursive: true });
            await fs.mkdir(path.join(this.metadataPath, "logs"), { recursive: true });

            // Clone git repository to user-facing location: ~/tenex/<dTag>/<branchName>/
            const repoUrl = this.project.repo;
            let actualRepoPath: string;

            if (repoUrl) {
                logger.info(`Project has repository: ${repoUrl}`, { projectId: this.projectId });
                const clonedPath = await cloneGitRepository(repoUrl, this.projectPath);
                if (!clonedPath) {
                    throw new Error(`Failed to clone repository: ${repoUrl}`);
                }
                actualRepoPath = clonedPath;
            } else {
                logger.info("Initializing new git repository", { projectId: this.projectId });
                actualRepoPath = await initializeGitRepository(this.projectPath);
            }

            // Update projectPath to point to the actual repository location
            this.projectPath = actualRepoPath;
            logger.info(`Git repository ready at: ${this.projectPath}`);

            // Initialize components
            const agentRegistry = new AgentRegistry(this.projectPath, this.metadataPath);
            await agentRegistry.loadFromProject(this.project);

            const llmLogger = new LLMLogger();
            llmLogger.initialize(this.metadataPath);

            // Create project context directly (don't use global singleton)
            this.context = new ProjectContext(this.project, agentRegistry, llmLogger);

            // Load MCP tools from project event
            await this.initializeMCPTools();

            // Initialize conversation coordinator with metadata path and context
            this.conversationCoordinator = new ConversationCoordinator(
                this.metadataPath,
                undefined,
                this.context
            );
            await this.conversationCoordinator.initialize();

            // Set conversation coordinator in context
            this.context.conversationCoordinator = this.conversationCoordinator;

            // Initialize event handler with the conversation coordinator
            this.eventHandler = new EventHandler(
                this.projectPath, // Git repo path for code execution
                this.conversationCoordinator // Shared conversation coordinator
            );
            await this.eventHandler.initialize();

            // Start status publisher
            this.statusPublisher = new ProjectStatusService();
            await projectContextStore.run(this.context, async () => {
                await this.statusPublisher?.startPublishing(
                    this.projectPath,
                    this.context ?? undefined
                );
            });

            this.isRunning = true;
            this.startTime = new Date();

            logger.info(`Project runtime started successfully: ${this.projectId}`, {
                agentCount: this.context.agents.size,
                pmPubkey: this.context.projectManager?.pubkey?.slice(0, 8),
            });

            console.log(chalk.green(`✅ Project started: ${chalk.bold(projectTitle)}`));
            console.log(
                chalk.gray(`   Agents: ${this.context.agents.size} | Path: ${this.projectPath}`)
            );
            console.log();
        } catch (error) {
            logger.error(`Failed to start project runtime: ${this.projectId}`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
        }
    }

    /**
     * Handle an incoming event
     */
    async handleEvent(event: NDKEvent): Promise<void> {
        if (!this.isRunning) {
            throw new Error(`Project runtime not running: ${this.projectId}`);
        }

        if (!this.context) {
            throw new Error(`Project context not initialized: ${this.projectId}`);
        }

        // Update stats
        this.lastEventTime = new Date();
        this.eventCount++;

        // Set project.dtag on active span for trace filtering
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
            activeSpan.setAttribute("project.dtag", this.dTag);
        }

        // Run event handler with the project context
        // AsyncLocalStorage ensures all async operations within this scope
        // have access to the correct project context
        await projectContextStore.run(this.context, async () => {
            if (this.eventHandler) {
                await this.eventHandler.handleEvent(event);
            }
        });
    }

    /**
     * Stop the project runtime
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            logger.warn(`Project runtime already stopped: ${this.projectId}`);
            return;
        }

        const projectTitle = this.project.tagValue("title") || "Untitled";
        console.log(chalk.yellow(`🛑 Stopping project: ${chalk.bold(projectTitle)}`));

        logger.info(`Stopping project runtime: ${this.projectId}`, {
            uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
            eventsProcessed: this.eventCount,
        });

        // Stop status publisher
        if (this.statusPublisher) {
            await this.statusPublisher.stopPublishing();
            this.statusPublisher = null;
        }

        // Cleanup event handler
        if (this.eventHandler) {
            await this.eventHandler.cleanup();
            this.eventHandler = null;
        }

        // Save conversation state
        if (this.conversationCoordinator) {
            await this.conversationCoordinator.cleanup();
            this.conversationCoordinator = null;
        }

        // Clear context
        this.context = null;

        this.isRunning = false;

        logger.info(`Project runtime stopped: ${this.projectId}`);

        const uptime = this.startTime
            ? Math.round((Date.now() - this.startTime.getTime()) / 1000)
            : 0;
        console.log(chalk.green(`✅ Project stopped: ${chalk.bold(projectTitle)}`));
        console.log(chalk.gray(`   Uptime: ${uptime}s | Events processed: ${this.eventCount}`));
        console.log();
    }

    /**
     * Get runtime status
     */
    getStatus(): {
        isRunning: boolean;
        projectId: string;
        title: string;
        startTime: Date | null;
        lastEventTime: Date | null;
        eventCount: number;
        agentCount: number;
    } {
        return {
            isRunning: this.isRunning,
            projectId: this.projectId,
            title: this.project.tagValue("title") || "Untitled",
            startTime: this.startTime,
            lastEventTime: this.lastEventTime,
            eventCount: this.eventCount,
            agentCount: this.context?.agents.size || 0,
        };
    }

    /**
     * Get the project context (if running)
     */
    getContext(): ProjectContext | null {
        return this.context;
    }

    /**
     * Check if runtime is running
     */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Initialize MCP tools from the project event
     * Extracts MCP tool event IDs from "mcp" tags, fetches and installs them
     */
    private async initializeMCPTools(): Promise<void> {
        try {
            // Extract MCP tool event IDs from the project
            const mcpEventIds = this.project.tags
                .filter((tag) => tag[0] === "mcp" && tag[1])
                .map((tag) => tag[1])
                .filter((id): id is string => typeof id === "string");

            logger.debug(
                `[ProjectRuntime] Found ${mcpEventIds.length} MCP tool(s) in project tags`,
                {
                    projectId: this.projectId,
                    mcpEventIds: mcpEventIds.map((id) => id.substring(0, 12)),
                }
            );

            if (mcpEventIds.length === 0) {
                logger.debug(
                    "[ProjectRuntime] No MCP tools defined in project, skipping MCP initialization"
                );
                return;
            }

            const ndk = getNDK();
            const installedCount = { success: 0, failed: 0 };

            // Fetch and install each MCP tool
            for (const eventId of mcpEventIds) {
                try {
                    logger.debug(
                        `[ProjectRuntime] Fetching MCP tool event: ${eventId.substring(0, 12)}...`
                    );
                    const mcpEvent = await ndk.fetchEvent(eventId);

                    if (!mcpEvent) {
                        logger.warn(
                            `[ProjectRuntime] MCP tool event not found: ${eventId.substring(0, 12)}`
                        );
                        installedCount.failed++;
                        continue;
                    }

                    const mcpTool = NDKMCPTool.from(mcpEvent);
                    logger.debug(
                        `[ProjectRuntime] Installing MCP tool: ${mcpTool.name || "unnamed"}`,
                        {
                            eventId: eventId.substring(0, 12),
                            command: mcpTool.command,
                        }
                    );

                    await installMCPServerFromEvent(this.projectPath, mcpTool);
                    installedCount.success++;

                    logger.info(`[ProjectRuntime] Installed MCP tool: ${mcpTool.name}`, {
                        eventId: eventId.substring(0, 12),
                        slug: mcpTool.slug,
                    });
                } catch (error) {
                    logger.error("[ProjectRuntime] Failed to install MCP tool", {
                        eventId: eventId.substring(0, 12),
                        error: error instanceof Error ? error.message : String(error),
                    });
                    installedCount.failed++;
                }
            }

            logger.info("[ProjectRuntime] MCP tool installation complete", {
                total: mcpEventIds.length,
                success: installedCount.success,
                failed: installedCount.failed,
            });

            // Initialize MCP service if any tools were installed
            if (installedCount.success > 0) {
                logger.info(
                    `[ProjectRuntime] Initializing MCP service with ${installedCount.success} tool(s)`
                );
                await mcpService.initialize(this.projectPath);

                const runningServers = mcpService.getRunningServers();
                const availableTools = Object.keys(mcpService.getCachedTools());

                logger.info("[ProjectRuntime] MCP service initialized", {
                    runningServers: runningServers.length,
                    runningServerNames: runningServers,
                    availableTools: availableTools.length,
                    toolNames: availableTools,
                });
            } else {
                logger.warn(
                    "[ProjectRuntime] No MCP tools were successfully installed, skipping MCP service initialization"
                );
            }
        } catch (error) {
            logger.error("[ProjectRuntime] Failed to initialize MCP tools", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            // Don't throw - allow project to start even if MCP initialization fails
        }
    }
}
