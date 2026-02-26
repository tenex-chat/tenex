import * as fs from "node:fs/promises";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { checkSupervisionHealth, registerDefaultHeuristics } from "@/agents/supervision";
import { ConversationStore } from "@/conversations/ConversationStore";
import { EventHandler } from "@/event-handler";
import { NDKMCPTool } from "@/events/NDKMCPTool";
import { getNDK } from "@/nostr";
import { ProjectContext } from "@/services/projects";
import { projectContextStore } from "@/services/projects";
import { MCPManager } from "@/services/mcp/MCPManager";
import { McpSubscriptionService } from "@/services/mcp/McpSubscriptionService";
import { deliverMcpNotification } from "@/services/mcp/McpNotificationDelivery";
import { installMCPServerFromEvent } from "@/services/mcp/mcpInstaller";
import { createLocalReportStore, LocalReportStore } from "@/services/reports";
import { ProjectStatusService } from "@/services/status/ProjectStatusService";
import { OperationsStatusService } from "@/services/status/OperationsStatusService";
import { prefixKVStore } from "@/services/storage";
import { RALRegistry } from "@/services/ral";
import { getPubkeyService } from "@/services/PubkeyService";
import { getTrustPubkeyService } from "@/services/trust-pubkeys";
import { cloneGitRepository, initializeGitRepository } from "@/utils/git";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { trace, SpanStatusCode } from "@opentelemetry/api";
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
    private mcpManager: MCPManager = new MCPManager();
    private localReportStore: LocalReportStore = createLocalReportStore();

    private isRunning = false;
    private startTime: Date | null = null;
    private lastEventTime: Date | null = null;
    private eventCount = 0;
    private prefixStoreInitialized = false;

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

            // Verify supervision system health (fail-fast if misconfigured)
            await this.verifySupervisionHealth();

            // Create project context directly (don't use global singleton)
            this.context = new ProjectContext(this.project, agentRegistry);

            // Initialize prefix KV store and index agent pubkeys
            // This is best-effort - indexing failures don't block project startup
            await prefixKVStore.initialize();
            this.prefixStoreInitialized = true;
            const agentPubkeysForIndex = Array.from(this.context.agents.values()).map(a => a.pubkey);
            try {
                await prefixKVStore.addBatch(agentPubkeysForIndex);
            } catch (error) {
                logger.warn("[ProjectRuntime] Failed to index agent pubkeys for prefix lookup", {
                    projectId: this.projectId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            // Load MCP tools from project event
            await this.initializeMCPTools();

            // Set mcpManager on context for use by tools and services
            this.context.mcpManager = this.mcpManager;

            // Initialize MCP subscription service for resource notification subscriptions
            // Must be done after mcpManager is set on context (subscriptions need MCP access).
            // The notification handler is wrapped in projectContextStore.run() because MCP
            // push notifications fire from SDK transport callbacks outside AsyncLocalStorage scope.
            const capturedContext = this.context;
            await projectContextStore.run(this.context, async () => {
                const mcpSubService = McpSubscriptionService.getInstance();
                mcpSubService.setNotificationHandler(async (subscription, content) => {
                    await projectContextStore.run(capturedContext, async () => {
                        await deliverMcpNotification(subscription, content);
                    });
                });
                await mcpSubService.initialize();
            });

            // Initialize and set local report store on context for project-scoped storage
            this.localReportStore.initialize(this.metadataPath);
            this.context.localReportStore = this.localReportStore;

            // NOTE: Nudge whitelist is initialized at daemon level (user-scoped, not project-scoped).
            // See Daemon.ts step 6d.

            // Initialize conversation store with project path and agent pubkeys
            const agentPubkeys = Array.from(this.context.agents.values()).map(a => a.pubkey);
            ConversationStore.initialize(this.metadataPath, agentPubkeys);

            // Reconcile any orphaned RALs from a previous daemon run
            await this.reconcileOrphanedRals();

            // Warm user profile cache for whitelisted pubkeys and project owner
            // This ensures getNameSync() returns real names instead of shortened pubkeys
            // for message attribution in delegations.
            // Must run within projectContextStore.run() since PubkeyService.getAgentSlug
            // needs project context to filter out agent pubkeys.
            await projectContextStore.run(this.context, async () => {
                await this.warmUserProfileCache();
            });

            // Initialize backend pubkey cache for the pubkey gate.
            // Must happen before EventHandler is initialized so that
            // isTrustedEventSync() can recognize backend-signed events
            // without an async fallback (fail-closed gate).
            await getTrustPubkeyService().initializeBackendPubkeyCache();

            // Initialize event handler
            this.eventHandler = new EventHandler();
            await this.eventHandler.initialize();

            // Start status publisher
            this.statusPublisher = new ProjectStatusService();
            const context = this.context;
            context.statusPublisher = this.statusPublisher;
            await projectContextStore.run(context, async () => {
                await this.statusPublisher?.startPublishing(
                    this.projectBasePath,
                    context
                );
            });

            // Start operations status publisher (uses RALRegistry for streaming-only semantics)
            // Pass projectId and context for multi-project isolation in daemon mode
            this.operationsStatusPublisher = new OperationsStatusService(
                RALRegistry.getInstance(),
                this.projectId,
                this.context
            );
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
            // Release prefix store reference if we acquired one during startup
            if (this.prefixStoreInitialized) {
                await prefixKVStore.close();
                this.prefixStoreInitialized = false;
            }

            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(chalk.red(`❌ Failed to start project: ${chalk.bold(projectTitle)}`));
            console.error(chalk.red(`   ${errorMessage}`));

            logger.error(`Failed to start project runtime: ${this.projectId}`, {
                error: errorMessage,
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
            process.stdout.write(chalk.gray("   Stopping status publisher..."));
            await this.statusPublisher.stopPublishing();
            this.statusPublisher = null;
            console.log(chalk.gray(" done"));
        }

        // Stop operations status publisher
        if (this.operationsStatusPublisher) {
            process.stdout.write(chalk.gray("   Stopping operations status..."));
            this.operationsStatusPublisher.stop();
            this.operationsStatusPublisher = null;
            console.log(chalk.gray(" done"));
        }

        // Cleanup event handler
        if (this.eventHandler) {
            process.stdout.write(chalk.gray("   Cleaning up event handler..."));
            await this.eventHandler.cleanup();
            this.eventHandler = null;
            console.log(chalk.gray(" done"));
        }

        // Shutdown MCP subscription service
        try {
            const mcpSubService = McpSubscriptionService.getInstance();
            await mcpSubService.shutdown();
        } catch {
            // Service may not be initialized
        }

        // Save conversation state
        process.stdout.write(chalk.gray("   Saving conversations..."));
        await ConversationStore.cleanup();
        console.log(chalk.gray(" done"));

        // Reset local report store
        process.stdout.write(chalk.gray("   Resetting report store..."));
        this.localReportStore.reset();
        console.log(chalk.gray(" done"));

        // Release our reference to the prefix KV store (but don't close it -
        // it's a daemon-global resource that outlives individual project runtimes)
        process.stdout.write(chalk.gray("   Releasing storage..."));
        await prefixKVStore.close();
        console.log(chalk.gray(" done"));

        // Clear context
        this.context = null;

        this.isRunning = false;

        logger.info(`Project runtime stopped: ${this.projectId}`);

        const uptime = this.startTime
            ? Math.round((Date.now() - this.startTime.getTime()) / 1000)
            : 0;
        console.log(chalk.green(`✅ Project stopped: ${chalk.bold(projectTitle)}`));
        console.log(chalk.gray(`   Uptime: ${uptime}s | Events processed: ${this.eventCount}`));
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

                    await installMCPServerFromEvent(this.metadataPath, mcpTool);
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
                await this.mcpManager.initialize(this.metadataPath, this.projectBasePath);

                const runningServers = this.mcpManager.getRunningServers();
                const availableTools = Object.keys(this.mcpManager.getCachedTools());

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

    /**
     * Warm the user profile cache for whitelisted pubkeys and project owner.
     * This ensures that getNameSync() returns real user names instead of shortened pubkeys
     * when attributing messages in delegations.
     */
    private async warmUserProfileCache(): Promise<void> {
        try {
            const { config: loadedConfig } = await config.loadConfig();
            const pubkeysToWarm: Set<string> = new Set();

            // Add whitelisted pubkeys
            const whitelistedPubkeys = loadedConfig.whitelistedPubkeys ?? [];
            for (const pk of whitelistedPubkeys) {
                if (pk) pubkeysToWarm.add(pk);
            }

            // Add project owner pubkey
            if (this.project.pubkey) {
                pubkeysToWarm.add(this.project.pubkey);
            }

            if (pubkeysToWarm.size === 0) {
                logger.debug("[ProjectRuntime] No user pubkeys to warm");
                return;
            }

            trace.getActiveSpan()?.addEvent("project_runtime.warming_user_profiles", {
                "profiles.count": pubkeysToWarm.size,
            });

            const pubkeyService = getPubkeyService();
            const results = await pubkeyService.warmUserProfiles(Array.from(pubkeysToWarm));

            logger.debug("[ProjectRuntime] Warmed user profile cache", {
                projectId: this.projectId,
                count: results.size,
            });

            trace.getActiveSpan()?.addEvent("project_runtime.user_profiles_warmed", {
                "profiles.warmed": results.size,
            });
        } catch (error) {
            // Don't block startup if profile warming fails
            logger.warn("[ProjectRuntime] Failed to warm user profile cache", {
                projectId: this.projectId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Scan all persisted conversations and reconcile orphaned RALs.
     * An orphaned RAL is one that's marked as "active" in ConversationStore
     * but doesn't exist in RALRegistry (because daemon was restarted).
     */
    private async reconcileOrphanedRals(): Promise<void> {
        const conversationsDir = path.join(this.metadataPath, "conversations");

        let files: string[];
        try {
            files = await fs.readdir(conversationsDir);
        } catch {
            return; // No conversations directory yet
        }

        const ralRegistry = RALRegistry.getInstance();
        let totalReconciled = 0;

        for (const file of files) {
            if (!file.endsWith(".json")) continue;

            const conversationId = file.replace(".json", "");
            const store = ConversationStore.getOrLoad(conversationId);

            const allActiveRals = store.getAllActiveRals();
            let modified = false;

            for (const [agentPubkey, ralNumbers] of allActiveRals) {
                for (const ralNumber of ralNumbers) {
                    // RALRegistry is empty after restart - any active RAL in ConversationStore is orphaned
                    const exists = ralRegistry.getRAL(agentPubkey, conversationId, ralNumber);
                    if (!exists) {
                        logger.info(`[ProjectRuntime] Reconciling orphaned RAL #${ralNumber}`, {
                            conversationId: conversationId.substring(0, 8),
                            agentPubkey: agentPubkey.substring(0, 8),
                        });

                        store.addMessage({
                            pubkey: agentPubkey,
                            ral: ralNumber,
                            content: `⚠️ RAL #${ralNumber} was interrupted (daemon restart). Work may be incomplete.`,
                            messageType: "text",
                        });
                        store.completeRal(agentPubkey, ralNumber);
                        modified = true;
                        totalReconciled++;
                    }
                }
            }

            if (modified) {
                await store.save();
            }
        }

        if (totalReconciled > 0) {
            logger.info(`[ProjectRuntime] Reconciled ${totalReconciled} orphaned RAL(s)`);
        }
    }

    /**
     * Verify supervision system health at startup.
     * Ensures heuristics are registered and the supervision system is properly configured.
     * This is a fail-fast check that prevents the daemon from running without supervision.
     *
     * Uses centralized health check for consistent fail-closed semantics across all entry points.
     */
    private async verifySupervisionHealth(): Promise<void> {
        const tracer = trace.getTracer("tenex.project-runtime");

        return tracer.startActiveSpan("tenex.supervision.health_check", async (span) => {
            span.setAttribute("project.id", this.projectId);

            // Ensure heuristics are registered before checking health
            registerDefaultHeuristics();

            // Use centralized health check for consistent validation
            const healthResult = checkSupervisionHealth();

            span.setAttributes({
                "supervision.registry_size": healthResult.registrySize,
                "supervision.heuristic_ids": healthResult.heuristicIds.join(","),
                "supervision.post_completion_count": healthResult.postCompletionCount,
                "supervision.healthy": healthResult.healthy,
            });

            if (!healthResult.healthy) {
                const errorMessage = `[ProjectRuntime] ${healthResult.errorMessage}`;

                logger.error(errorMessage);
                span.recordException(new Error(errorMessage));
                span.setStatus({ code: SpanStatusCode.ERROR, message: healthResult.errorMessage });
                span.end();

                throw new Error(errorMessage);
            }

            span.addEvent("supervision.health_check_passed", {
                "heuristics.count": healthResult.registrySize,
                "heuristics.post_completion_count": healthResult.postCompletionCount,
            });

            span.setStatus({ code: SpanStatusCode.OK });

            logger.info("[ProjectRuntime] Supervision system health check passed", {
                projectId: this.projectId,
                heuristicCount: healthResult.registrySize,
                heuristicIds: healthResult.heuristicIds,
                postCompletionCount: healthResult.postCompletionCount,
            });

            span.end();
        });
    }
}
