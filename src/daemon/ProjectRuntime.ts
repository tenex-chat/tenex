import * as fs from "node:fs/promises";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { ConversationCoordinator } from "@/conversations";
import { EventHandler } from "@/event-handler";
import { NDKMCPTool } from "@/events/NDKMCPTool";
import { getNDK } from "@/nostr";
import { ProjectContext } from "@/services/ProjectContext";
import { projectContextStore } from "@/services/ProjectContextStore";
import { mcpService } from "@/services/mcp/MCPManager";
import { installMCPServerFromEvent } from "@/services/mcp/mcpInstaller";
import { ProjectStatusService } from "@/services/status/ProjectStatusService";
import { OperationsStatusService } from "@/services/status/OperationsStatusService";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
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
    /**
     * Project directory (normal git repository root).
     * Example: ~/tenex/{dTag}
     * The default branch is checked out here directly.
     * Worktrees go in .worktrees/ subdirectory.
     */
    public readonly projectBasePath: string;
    private readonly metadataPath: string; // TENEX metadata path
    private readonly dTag: string;

    private project: NDKProject;
    private context: ProjectContext | null = null;
    private eventHandler: EventHandler | null = null;
    private statusPublisher: ProjectStatusService | null = null;
    private operationsStatusPublisher: OperationsStatusService | null = null;
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

        // Project directory: {projectsBase}/{dTag}
        // Normal git repo with default branch checked out.
        // Worktrees go in .worktrees/ subdirectory.
        this.projectBasePath = path.join(projectsBase, dTag);

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

        trace.getActiveSpan()?.addEvent("project_runtime.starting", {
            "project.id": this.projectId,
            "project.title": this.project.tagValue("title") ?? "",
        });

        try {
            // Create TENEX metadata directories: ~/.tenex/projects/<dTag>/{conversations,logs}
            await fs.mkdir(path.join(this.metadataPath, "conversations"), { recursive: true });
            await fs.mkdir(path.join(this.metadataPath, "logs"), { recursive: true });

            // Clone or init git repository at ~/tenex/<dTag>/
            const repoUrl = this.project.repo;

            if (repoUrl) {
                trace.getActiveSpan()?.addEvent("project_runtime.cloning_repo", {
                    "repo.url": repoUrl,
                });
                const result = await cloneGitRepository(repoUrl, this.projectBasePath);
                if (!result) {
                    throw new Error(`Failed to clone repository: ${repoUrl}`);
                }
            } else {
                trace.getActiveSpan()?.addEvent("project_runtime.init_repo");
                await initializeGitRepository(this.projectBasePath);
            }

            trace.getActiveSpan()?.addEvent("project_runtime.repo_ready", {
                "project.path": this.projectBasePath,
            });

            // Initialize components
            const agentRegistry = new AgentRegistry(this.projectBasePath, this.metadataPath);
            await agentRegistry.loadFromProject(this.project);

            // Create project context directly (don't use global singleton)
            this.context = new ProjectContext(this.project, agentRegistry);

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

            // Initialize pairing manager for real-time delegation supervision
            const { PairingManager } = await import("@/services/pairing");
            const pairingManager = new PairingManager(async (agentPubkey, conversationId) => {
                await this.triggerAgentForCheckpoint(agentPubkey, conversationId);
            });
            this.context.pairingManager = pairingManager;

            // Initialize event handler with the conversation coordinator
            this.eventHandler = new EventHandler(
                this.projectBasePath, // Base project path for worktree operations
                this.conversationCoordinator // Shared conversation coordinator
            );
            await this.eventHandler.initialize();

            // Start status publisher
            this.statusPublisher = new ProjectStatusService();
            await projectContextStore.run(this.context, async () => {
                await this.statusPublisher?.startPublishing(
                    this.projectBasePath,
                    this.context ?? undefined
                );
            });

            // Start operations status publisher
            this.operationsStatusPublisher = new OperationsStatusService(llmOpsRegistry);
            this.operationsStatusPublisher.start();

            this.isRunning = true;
            this.startTime = new Date();

            logger.info(`Project runtime started successfully: ${this.projectId}`, {
                agentCount: this.context.agents.size,
                pmPubkey: this.context.projectManager?.pubkey?.slice(0, 8),
            });

            console.log(chalk.green(`✅ Project started: ${chalk.bold(projectTitle)}`));
            console.log(
                chalk.gray(`   Agents: ${this.context.agents.size} | Path: ${this.projectBasePath}`)
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

        trace.getActiveSpan()?.addEvent("project_runtime.stopping", {
            "project.id": this.projectId,
            "uptime_ms": this.startTime ? Date.now() - this.startTime.getTime() : 0,
            "events.processed": this.eventCount,
        });

        // Stop status publisher
        if (this.statusPublisher) {
            await this.statusPublisher.stopPublishing();
            this.statusPublisher = null;
        }

        // Stop operations status publisher
        if (this.operationsStatusPublisher) {
            this.operationsStatusPublisher.stop();
            this.operationsStatusPublisher = null;
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

        // Stop all active pairings to clean up subscriptions
        if (this.context?.pairingManager) {
            this.context.pairingManager.stopAll();
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
     * Trigger agent execution for a pairing checkpoint.
     * Used by PairingManager when it queues a checkpoint and needs to resume the supervisor.
     */
    async triggerAgentForCheckpoint(agentPubkey: string, conversationId: string): Promise<void> {
        if (!this.isRunning || !this.context || !this.conversationCoordinator) {
            logger.warn("[ProjectRuntime] Cannot trigger checkpoint - runtime not ready", {
                projectId: this.projectId,
                isRunning: this.isRunning,
            });
            return;
        }

        const context = this.context;
        const coordinator = this.conversationCoordinator;
        if (!context || !coordinator) {
            logger.error("[ProjectRuntime] Missing context or coordinator for checkpoint trigger");
            return;
        }

        await projectContextStore.run(context, async () => {
            const agent = context.getAgentByPubkey(agentPubkey);
            if (!agent) {
                logger.error("[ProjectRuntime] Agent not found for checkpoint trigger", {
                    agentPubkey: agentPubkey.substring(0, 8),
                    projectId: this.projectId,
                });
                return;
            }

            const conversation = await coordinator.getConversation(conversationId);
            if (!conversation) {
                logger.error("[ProjectRuntime] Conversation not found for checkpoint trigger", {
                    conversationId: conversationId.substring(0, 8),
                    projectId: this.projectId,
                });
                return;
            }

            // Use root event as triggering context
            const rootEvent = conversation.history[0];
            if (!rootEvent) {
                logger.error("[ProjectRuntime] No root event in conversation", {
                    conversationId: conversationId.substring(0, 8),
                });
                return;
            }

            logger.info("[ProjectRuntime] Triggering agent for pairing checkpoint", {
                agentSlug: agent.slug,
                conversationId: conversationId.substring(0, 8),
            });

            // Create execution context and execute
            const { createExecutionContext } = await import("@/agents/execution/ExecutionContextFactory");
            const { AgentExecutor } = await import("@/agents/execution/AgentExecutor");

            const executionContext = await createExecutionContext({
                agent,
                conversationId,
                projectBasePath: this.projectBasePath,
                triggeringEvent: rootEvent,
                conversationCoordinator: coordinator,
            });

            const agentExecutor = new AgentExecutor();
            await agentExecutor.execute(executionContext);
        });
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

            trace.getActiveSpan()?.addEvent("project_runtime.mcp_tools_found", {
                "mcp.count": mcpEventIds.length,
            });

            if (mcpEventIds.length === 0) {
                return;
            }

            const ndk = getNDK();
            const installedCount = { success: 0, failed: 0 };

            // Fetch and install each MCP tool
            for (const eventId of mcpEventIds) {
                try {
                    trace.getActiveSpan()?.addEvent("project_runtime.mcp_fetching", {
                        "mcp.event_id": eventId.substring(0, 12),
                    });
                    const mcpEvent = await ndk.fetchEvent(eventId);

                    if (!mcpEvent) {
                        logger.warn(
                            `[ProjectRuntime] MCP tool event not found: ${eventId.substring(0, 12)}`
                        );
                        installedCount.failed++;
                        continue;
                    }

                    const mcpTool = NDKMCPTool.from(mcpEvent);
                    trace.getActiveSpan()?.addEvent("project_runtime.mcp_installing", {
                        "mcp.name": mcpTool.name ?? "unnamed",
                        "mcp.event_id": eventId.substring(0, 12),
                    });

                    await installMCPServerFromEvent(this.projectBasePath, mcpTool);
                    installedCount.success++;

                    trace.getActiveSpan()?.addEvent("project_runtime.mcp_installed", {
                        "mcp.name": mcpTool.name ?? "",
                        "mcp.slug": mcpTool.slug ?? "",
                    });
                } catch (error) {
                    logger.error("[ProjectRuntime] Failed to install MCP tool", {
                        eventId: eventId.substring(0, 12),
                        error: error instanceof Error ? error.message : String(error),
                    });
                    installedCount.failed++;
                }
            }

            trace.getActiveSpan()?.addEvent("project_runtime.mcp_installation_complete", {
                "mcp.total": mcpEventIds.length,
                "mcp.success": installedCount.success,
                "mcp.failed": installedCount.failed,
            });

            // Initialize MCP service if any tools were installed
            if (installedCount.success > 0) {
                await mcpService.initialize(this.projectBasePath);

                const runningServers = mcpService.getRunningServers();
                const availableTools = Object.keys(mcpService.getCachedTools());

                trace.getActiveSpan()?.addEvent("project_runtime.mcp_service_initialized", {
                    "mcp.running_servers": runningServers.length,
                    "mcp.available_tools": availableTools.length,
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
