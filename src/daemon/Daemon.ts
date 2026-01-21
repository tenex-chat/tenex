import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import type { AgentInstance } from "@/agents/types";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { Lockfile } from "@/utils/lockfile";
import { shouldTrustLesson } from "@/utils/lessonTrust";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKProject } from "@nostr-dev-kit/ndk";
import { context as otelContext, trace, type Span } from "@opentelemetry/api";
import { getConversationSpanManager } from "@/telemetry/ConversationSpanManager";
import type { RoutingDecision } from "./routing/DaemonRouter";
import type { ProjectRuntime } from "./ProjectRuntime";
import { RuntimeLifecycle } from "./RuntimeLifecycle";
import { SubscriptionManager } from "./SubscriptionManager";
import { DaemonRouter } from "./routing/DaemonRouter";
import type { DaemonStatus } from "./types";
import { createEventSpan, endSpanSuccess, endSpanError, addRoutingEvent } from "./utils/telemetry";
import { logDropped, logRouted } from "./utils/routing-log";
import { UnixSocketTransport } from "./UnixSocketTransport";
import { streamPublisher } from "@/llm";

const lessonTracer = trace.getTracer("tenex.lessons");

/**
 * Main daemon that manages all projects in a single process.
 * Uses lazy loading - projects only start when they receive events.
 *
 * This class now focuses on orchestration, delegating specific responsibilities to:
 * - RuntimeLifecycle: Runtime management (start/stop/restart)
 * - DaemonRouter: Event routing decisions
 * - SubscriptionFilterBuilder: Filter construction
 * - AgentEventDecoder: Event classification
 */
export class Daemon {
    private ndk: NDK | null = null;
    private subscriptionManager: SubscriptionManager | null = null;
    private routingLogger: EventRoutingLogger;
    private whitelistedPubkeys: Hexpubkey[] = [];
    private projectsBase = "";
    private daemonDir = "";
    private isRunning = false;
    private shutdownHandlers: Array<() => Promise<void>> = [];
    private lockfile: Lockfile | null = null;
    private streamTransport: UnixSocketTransport | null = null;

    // Runtime management delegated to RuntimeLifecycle
    private runtimeLifecycle: RuntimeLifecycle | null = null;

    // Project management
    private knownProjects = new Map<string, NDKProject>(); // All discovered projects

    // Agent pubkey mapping for routing (pubkey -> project IDs)
    private agentPubkeyToProjects = new Map<Hexpubkey, Set<string>>();

    constructor() {
        this.routingLogger = new EventRoutingLogger();
    }

    /**
     * Initialize and start the daemon
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn("Daemon is already running");
            return;
        }

        try {
            // 1. Initialize base directories
            await this.initializeDirectories();

            // 2. Acquire lockfile to prevent multiple daemon instances
            await this.acquireDaemonLock();

            // 3. Initialize routing logger
            this.routingLogger.initialize(this.daemonDir);

            // 4. Load configuration
            const { config: loadedConfig } = await config.loadConfig();
            const whitelistedPubkeys = loadedConfig.whitelistedPubkeys;
            if (!whitelistedPubkeys) {
                throw new Error("whitelistedPubkeys not configured");
            }
            this.whitelistedPubkeys = whitelistedPubkeys;
            const projectsBase = config.getProjectsBase();
            if (!loadedConfig.projectsBase) {
                logger.warn(`projectsBase not configured, falling back to default: ${projectsBase}`);
            }
            this.projectsBase = projectsBase;

            if (this.whitelistedPubkeys.length === 0) {
                throw new Error("No whitelisted pubkeys configured. Run 'tenex setup' first.");
            }

            // 5. Initialize NDK
            await initNDK();
            this.ndk = getNDK();

            // 6. Initialize runtime lifecycle manager
            this.runtimeLifecycle = new RuntimeLifecycle(this.projectsBase);

            // 7. Initialize subscription manager (before discovery)
            this.subscriptionManager = new SubscriptionManager(
                this.ndk,
                this.handleIncomingEvent.bind(this), // Pass event handler
                this.whitelistedPubkeys,
                this.routingLogger
            );

            // 8. Start subscription immediately
            // Projects will be discovered naturally as events arrive
            await this.subscriptionManager.start();

            // 9. Start local streaming socket
            this.streamTransport = new UnixSocketTransport();
            await this.streamTransport.start();
            streamPublisher.setTransport(this.streamTransport);
            logger.info("Local streaming socket started", { path: this.streamTransport.getSocketPath() });

            // 10. Setup graceful shutdown
            this.setupShutdownHandlers();

            this.isRunning = true;

        } catch (error) {
            logger.error("Failed to start daemon", {
                error: error instanceof Error ? error.message : String(error),
            });

            // Release lockfile on startup failure
            if (this.lockfile) {
                await this.lockfile.release().catch((releaseError) => {
                    logger.warn("Failed to release lockfile during error cleanup", {
                        error:
                            releaseError instanceof Error
                                ? releaseError.message
                                : String(releaseError),
                    });
                });
            }

            throw error;
        }
    }

    /**
     * Initialize required directories for daemon operations
     */
    private async initializeDirectories(): Promise<void> {
        // Use global daemon directory instead of project-local .tenex
        this.daemonDir = config.getConfigPath("daemon");

        const dirs = [this.daemonDir, path.join(this.daemonDir, "logs")];

        for (const dir of dirs) {
            await fs.mkdir(dir, { recursive: true });
        }

    }

    /**
     * Acquire daemon lockfile to prevent multiple instances
     */
    private async acquireDaemonLock(): Promise<void> {
        const lockfilePath = path.join(config.getConfigPath("daemon"), "tenex.lock");
        this.lockfile = new Lockfile(lockfilePath);
        await this.lockfile.acquire();
    }

    /**
     * Build project ID from event
     */
    private buildProjectId(event: NDKEvent): string {
        const dTag = event.tags.find((t) => t[0] === "d")?.[1];
        if (!dTag) {
            throw new Error("Project event missing d tag");
        }
        return `31933:${event.pubkey}:${dTag}`;
    }

    /**
     * Handle incoming events from the subscription (telemetry wrapper)
     */
    private async handleIncomingEvent(event: NDKEvent): Promise<void> {
        // Check if this daemon should process this event at all.
        // This prevents noisy traces when multiple backends are running.
        const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
        if (
            !DaemonRouter.willThisRoute(
                event,
                this.knownProjects,
                this.agentPubkeyToProjects,
                activeRuntimes
            )
        ) {
            // Not our event - drop silently without creating a span
            return;
        }

        const span = createEventSpan(event);

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                await this.processIncomingEvent(event, span);
                endSpanSuccess(span);
            } catch (error) {
                if (!event.id) {
                    throw new Error("Event ID not found");
                }
                if (!event.id) {
                    throw new Error("Event ID not found");
                }
                logger.error("Error handling incoming event", {
                    error: error instanceof Error ? error.message : String(error),
                    eventId: event.id,
                });
                endSpanError(span, error);
            }
        });
    }

    /**
     * Process incoming event (pure business logic, telemetry-free)
     */
    private async processIncomingEvent(
        event: NDKEvent,
        span: Span
    ): Promise<void> {
        // Classify event type
        const eventType = AgentEventDecoder.classifyForDaemon(event);

        // Handle project events (kind 31933)
        if (eventType === "project") {
            addRoutingEvent(span, "project_event", { reason: "kind_31933" });
            await this.handleProjectEvent(event);
            await logDropped(this.routingLogger, event, "Project creation/update event");
            return;
        }

        // Handle lesson events (kind 4129)
        if (eventType === "lesson") {
            addRoutingEvent(span, "lesson_event", { reason: "kind_4129" });
            await this.handleLessonEvent(event);
            await logDropped(this.routingLogger, event, "Lesson event - hydrated into active runtimes only");
            return;
        }

        // Filter out agent events without p-tags (but allow root events)
        // Root events are conversation starters and don't need p-tags
        const isRootEvent = !AgentEventDecoder.getReplyTarget(event);
        if (
            DaemonRouter.isAgentEvent(event, this.agentPubkeyToProjects) &&
            !DaemonRouter.hasPTagsToSystemEntities(event, this.whitelistedPubkeys, this.agentPubkeyToProjects) &&
            !isRootEvent
        ) {
            addRoutingEvent(span, "dropped", { reason: "agent_event_without_p_tags" });
            await logDropped(this.routingLogger, event, "Agent event without p-tags to system entities");
            return;
        }

        // Determine target project
        const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
        const routingResult = DaemonRouter.determineTargetProject(
            event,
            this.knownProjects,
            this.agentPubkeyToProjects,
            activeRuntimes
        );

        if (!routingResult.projectId) {
            addRoutingEvent(span, "dropped", { reason: routingResult.reason });
            await logDropped(this.routingLogger, event, routingResult.reason);
            return;
        }

        addRoutingEvent(span, "route_to_project", {
            projectId: routingResult.projectId,
            method: routingResult.method
        });

        await this.routeEventToProject(event, routingResult, span);
    }

    /**
     * Route event to a specific project (business logic)
     */
    private async routeEventToProject(
        event: NDKEvent,
        routingResult: RoutingDecision,
        span: Span
    ): Promise<void> {
        if (!this.runtimeLifecycle) {
            logger.error("RuntimeLifecycle not initialized");
            return;
        }

        const projectId = routingResult.projectId;
        if (!projectId) {
            addRoutingEvent(span, "error", { error: "no_project_id" });
            await logDropped(this.routingLogger, event, "No project ID in routing result");
            return;
        }

        const project = this.knownProjects.get(projectId);
        if (!project) {
            addRoutingEvent(span, "error", { error: "unknown_project" });
            await logDropped(this.routingLogger, event, "Project not found in known projects");
            return;
        }

        // Check if runtime exists
        let runtime = this.runtimeLifecycle.getRuntime(projectId);

        if (!runtime) {
            // Only kind:1 (Text) and kind:24000 (TenexBootProject) can boot projects
            const canBootProject = event.kind === 1 || event.kind === 24000;

            if (!canBootProject) {
                addRoutingEvent(span, "dropped", { reason: "no_runtime_and_cannot_boot" });
                await logDropped(
                    this.routingLogger,
                    event,
                    `Project not running and kind:${event.kind} cannot boot projects`
                );
                return;
            }

            // Start the project runtime
            try {
                addRoutingEvent(span, "project_runtime_start", {
                    title: project.tagValue("title") || "untitled",
                    bootKind: event.kind,
                });
                runtime = await this.runtimeLifecycle.startRuntime(projectId, project);
                await this.updateSubscriptionWithProjectAgents(projectId, runtime);
            } catch (error) {
                logger.error("Failed to start runtime", { projectId, error });
                await logDropped(this.routingLogger, event, "Failed to start runtime");
                return;
            }
        }

        // Log successful routing
        if (!routingResult.matchedTags) {
            throw new Error("Routing matchedTags not found");
        }
        if (!routingResult.method) {
            throw new Error("Routing method not found");
        }
        if (!routingResult.matchedTags) {
            throw new Error("Routing matchedTags not found");
        }
        if (!routingResult.method) {
            throw new Error("Routing method not found");
        }
        if (routingResult.method !== "none") {
            await logRouted(
                this.routingLogger,
                event,
                projectId,
                routingResult.method,
                routingResult.matchedTags
            );
        }

        // Handle the event with crash isolation
        try {
            if (!event.id) {
                throw new Error("Event ID not found");
            }
            await runtime.handleEvent(event);
        } catch (error) {
            logger.error("Project runtime crashed", { projectId, eventId: event.id });
            await this.runtimeLifecycle.handleRuntimeCrash(projectId, runtime);
            throw error; // Re-throw to mark span as error
        }
    }

    /**
     * Collect all agent pubkeys and definition IDs from active runtimes
     */
    private collectAgentData(): { pubkeys: Set<Hexpubkey>; definitionIds: Set<string> } {
        const pubkeys = new Set<Hexpubkey>();
        const definitionIds = new Set<string>();

        if (!this.runtimeLifecycle) {
            return { pubkeys, definitionIds };
        }

        const activeRuntimes = this.runtimeLifecycle.getActiveRuntimes();
        for (const [pid, rt] of activeRuntimes) {
            const context = rt.getContext();
            if (!context) {
                throw new Error(
                    `Runtime for project ${pid} has no context during agent collection`
                );
            }

            const agents = context.agentRegistry.getAllAgents();
            for (const agent of agents) {
                pubkeys.add(agent.pubkey);

                // Collect agent definition event IDs for lesson monitoring
                // Note: eventId may be null for locally-created agents
                if (agent.eventId) {
                    definitionIds.add(agent.eventId);
                }
            }
        }

        return { pubkeys, definitionIds };
    }

    /**
     * Update subscription with agent pubkeys and definition IDs from all active runtimes
     */
    private async updateSubscriptionWithProjectAgents(
        projectId: string,
        _runtime: ProjectRuntime
    ): Promise<void> {
        if (!this.subscriptionManager) return;

        try {
            const { pubkeys: allAgentPubkeys, definitionIds: allAgentDefinitionIds } =
                this.collectAgentData();

            // Track which projects each agent belongs to
            const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
            for (const [pid, rt] of activeRuntimes) {
                const context = rt.getContext();
                if (!context) {
                    throw new Error(
                        `Runtime for project ${pid} has no context during subscription update`
                    );
                }

                const agents = context.agentRegistry.getAllAgents();
                for (const agent of agents) {
                    if (!this.agentPubkeyToProjects.has(agent.pubkey)) {
                        this.agentPubkeyToProjects.set(agent.pubkey, new Set());
                    }

                    const projectSet = this.agentPubkeyToProjects.get(agent.pubkey);
                    if (!projectSet) {
                        throw new Error(
                            `Agent pubkey ${agent.pubkey.slice(0, 8)} missing from agentPubkeyToProjects after set`
                        );
                    }
                    projectSet.add(pid);
                }
            }

            this.subscriptionManager.updateAgentPubkeys(Array.from(allAgentPubkeys));
            this.subscriptionManager.updateAgentDefinitionIds(Array.from(allAgentDefinitionIds));
        } catch (error) {
            logger.error("Failed to update subscription with project agents", {
                projectId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Handle project creation/update events
     */
    private async handleProjectEvent(event: NDKEvent): Promise<void> {
        const projectId = this.buildProjectId(event);
        const project = new NDKProject(getNDK(), event.rawEvent());
        const isNewProject = !this.knownProjects.has(projectId);

        this.knownProjects.set(projectId, project);

        // Update subscription for new projects
        if (isNewProject && this.subscriptionManager) {
            this.subscriptionManager.updateKnownProjects(Array.from(this.knownProjects.keys()));
        }

        // Route to active runtime if exists
        const runtime = this.runtimeLifecycle?.getRuntime(projectId);
        if (runtime) {
            await runtime.handleEvent(event);
            await this.updateSubscriptionWithProjectAgents(projectId, runtime);
        }
    }

    /**
     * Handle lesson events (kind 4129) - hydrate into active runtimes only
     * Does NOT start new project runtimes
     */
    private async handleLessonEvent(event: NDKEvent): Promise<void> {
        const span = lessonTracer.startSpan("tenex.lesson.received", {
            attributes: {
                "lesson.event_id": event.id?.substring(0, 16) || "unknown",
                "lesson.publisher": event.pubkey?.substring(0, 16) || "unknown",
                "lesson.created_at": event.created_at || 0,
            },
        });

        try {
            const lesson = NDKAgentLesson.from(event);
            span.setAttribute("lesson.title", lesson.title || "untitled");

            // Check if we should trust this lesson
            if (!shouldTrustLesson(lesson, event.pubkey)) {
                span.setAttribute("lesson.rejected", true);
                span.setAttribute("lesson.rejection_reason", "trust_check_failed");
                span.end();
                return;
            }

            const agentDefinitionId = lesson.agentDefinitionId;
            const lessonAuthorPubkey = event.pubkey;
            span.setAttribute("lesson.agent_definition_id", agentDefinitionId?.substring(0, 16) || "none");
            span.setAttribute("lesson.author_pubkey", lessonAuthorPubkey?.substring(0, 16) || "unknown");

            // Hydrate lesson into ACTIVE runtimes only (don't start new ones)
            const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
            span.setAttribute("lesson.active_runtimes_count", activeRuntimes.size);

            let totalMatches = 0;
            let totalAgentsChecked = 0;

            for (const [projectId, runtime] of activeRuntimes) {
                try {
                    const context = runtime.getContext();
                    if (!context) {
                        continue;
                    }

                    const allAgents = context.agentRegistry.getAllAgents();
                    totalAgentsChecked += allAgents.length;

                    // Match agents by EITHER:
                    // 1. Author pubkey (the agent published this lesson)
                    // 2. Definition eventId (lesson references agent's definition via e-tag)
                    const matchingAgents = allAgents.filter((agent: AgentInstance) => {
                        // Always match if the agent authored this lesson
                        if (agent.pubkey === lessonAuthorPubkey) {
                            return true;
                        }
                        // Also match if lesson references this agent's definition (and agent has an eventId)
                        if (agentDefinitionId && agent.eventId === agentDefinitionId) {
                            return true;
                        }
                        return false;
                    });

                    if (matchingAgents.length === 0) {
                        // Log all agent info for debugging
                        const agentInfo = allAgents.map((a: AgentInstance) => ({
                            slug: a.slug,
                            pubkey: a.pubkey.substring(0, 16),
                            eventId: a.eventId?.substring(0, 16) || "none",
                        }));
                        span.addEvent("no_matching_agents_in_project", {
                            "project.id": projectId,
                            "project.agent_count": allAgents.length,
                            "project.agents": JSON.stringify(agentInfo),
                            "lesson.agent_definition_id": agentDefinitionId?.substring(0, 16) || "none",
                            "lesson.author_pubkey": lessonAuthorPubkey?.substring(0, 16) || "unknown",
                        });
                        continue;
                    }

                    // Store the lesson for each matching agent
                    for (const agent of matchingAgents) {
                        const matchedByAuthor = agent.pubkey === lessonAuthorPubkey;
                        const matchedByEventId = agentDefinitionId && agent.eventId === agentDefinitionId;
                        const matchReason = matchedByAuthor && matchedByEventId
                            ? "author_and_event_id"
                            : matchedByAuthor
                                ? "author_pubkey"
                                : "event_id";

                        context.addLesson(agent.pubkey, lesson);
                        totalMatches++;
                        span.addEvent("lesson_stored", {
                            "agent.slug": agent.slug,
                            "agent.pubkey": agent.pubkey.substring(0, 16),
                            "project.id": projectId,
                            "lesson.title": lesson.title || "untitled",
                            "match_reason": matchReason,
                        });
                        logger.info("Stored lesson for agent", {
                            agentSlug: agent.slug,
                            lessonTitle: lesson.title,
                            lessonId: event.id?.substring(0, 8),
                            matchReason,
                        });
                    }
                } catch (error) {
                    span.addEvent("hydration_error", {
                        "project.id": projectId,
                        "error": error instanceof Error ? error.message : String(error),
                    });
                    logger.error("Failed to hydrate lesson into project", {
                        projectId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            span.setAttribute("lesson.total_agents_checked", totalAgentsChecked);
            span.setAttribute("lesson.total_matches", totalMatches);
            span.setAttribute("lesson.stored", totalMatches > 0);
            span.end();
        } catch (error) {
            span.setAttribute("error", true);
            span.setAttribute("error.message", error instanceof Error ? error.message : String(error));
            span.end();
            throw error;
        }
    }

    /**
     * Setup graceful shutdown handlers
     */
    private setupShutdownHandlers(): void {
        const shutdown = async (initiator?: string): Promise<void> => {
            if (initiator) {
                logger.info(`Shutdown initiated by ${initiator}`);
            }
            if (!this.isRunning) {
                process.exit(0);
            }

            this.isRunning = false;

            try {
                // Stop streaming socket
                if (this.streamTransport) {
                    await this.streamTransport.stop();
                    streamPublisher.setTransport(null);
                    this.streamTransport = null;
                }

                // Stop accepting new events
                if (this.subscriptionManager) {
                    this.subscriptionManager.stop();
                }

                // Stop all active project runtimes
                if (this.runtimeLifecycle) {
                    await this.runtimeLifecycle.stopAllRuntimes();
                }

                // Run custom shutdown handlers
                for (const handler of this.shutdownHandlers) {
                    await handler();
                }

                // Release lockfile
                if (this.lockfile) {
                    await this.lockfile.release();
                }

                // Shutdown conversation span manager
                const conversationSpanManager = getConversationSpanManager();
                conversationSpanManager.shutdown();

                process.exit(0);
            } catch (error) {
                logger.error("Error during shutdown", {
                    error: error instanceof Error ? error.message : String(error),
                });
                process.exit(1);
            }
        };

        process.on("SIGTERM", () => shutdown());
        process.on("SIGINT", () => shutdown());
        process.on("SIGHUP", () => shutdown("SIGHUP"));

        // Handle uncaught exceptions
        process.on("uncaughtException", (error) => {
            logger.error("Uncaught exception", {
                error: error.message,
                stack: error.stack,
            });
            shutdown("uncaughtException");
        });

        process.on("unhandledRejection", (reason, promise) => {
            logger.error("Unhandled rejection", {
                reason: String(reason),
                promise: String(promise),
            });
            // Don't shutdown - most unhandled rejections are not critical
            // e.g., relay rejections like "replaced: have newer event"
        });
    }

    /**
     * Add a custom shutdown handler
     */
    addShutdownHandler(handler: () => Promise<void>): void {
        this.shutdownHandlers.push(handler);
    }

    /**
     * Get daemon status
     */
    getStatus(): DaemonStatus {
        // Count total agents across all known projects
        let totalAgents = 0;
        for (const project of this.knownProjects.values()) {
            const agentTags = project.tags.filter((t) => t[0] === "agent");
            totalAgents += agentTags.length;
        }

        const runtimeStats = this.runtimeLifecycle?.getStats() || {
            activeCount: 0,
            startingCount: 0,
        };

        return {
            running: this.isRunning,
            knownProjects: this.knownProjects.size,
            activeProjects: runtimeStats.activeCount,
            startingProjects: runtimeStats.startingCount,
            totalAgents,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
        };
    }

    /**
     * Get known projects
     */
    getKnownProjects(): Map<string, NDKProject> {
        return this.knownProjects;
    }

    /**
     * Get active runtimes
     */
    getActiveRuntimes(): Map<string, ProjectRuntime> {
        return this.runtimeLifecycle?.getActiveRuntimes() || new Map();
    }

    /**
     * Kill a specific project runtime
     * @param projectId - The project ID to kill
     * @throws Error if the runtime is not found or not running
     */
    async killRuntime(projectId: string): Promise<void> {
        if (!this.runtimeLifecycle) {
            throw new Error("RuntimeLifecycle not initialized");
        }


        try {
            await this.runtimeLifecycle.stopRuntime(projectId);

            // Update subscription to remove this project's agent pubkeys
            await this.updateSubscriptionAfterRuntimeRemoved(projectId);

        } catch (error) {
            logger.error(`Failed to kill project runtime: ${projectId}`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Restart a specific project runtime
     * @param projectId - The project ID to restart
     * @throws Error if the runtime is not found or restart fails
     */
    async restartRuntime(projectId: string): Promise<void> {
        if (!this.runtimeLifecycle) {
            throw new Error("RuntimeLifecycle not initialized");
        }

        const project = this.knownProjects.get(projectId);
        if (!project) {
            throw new Error(`Project not found: ${projectId}`);
        }


        try {
            const runtime = await this.runtimeLifecycle.restartRuntime(projectId, project);

            // Update subscription with potentially new agent pubkeys
            await this.updateSubscriptionWithProjectAgents(projectId, runtime);

        } catch (error) {
            logger.error(`Failed to restart project runtime: ${projectId}`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Start a specific project runtime
     * @param projectId - The project ID to start
     * @throws Error if the project is not found or already running
     */
    async startRuntime(projectId: string): Promise<void> {
        if (!this.runtimeLifecycle) {
            throw new Error("RuntimeLifecycle not initialized");
        }

        // Check if project exists in known projects
        const project = this.knownProjects.get(projectId);
        if (!project) {
            throw new Error(`Project not found: ${projectId}`);
        }

        try {
            const runtime = await this.runtimeLifecycle.startRuntime(projectId, project);

            // Update subscription with this project's agent pubkeys
            await this.updateSubscriptionWithProjectAgents(projectId, runtime);

        } catch (error) {
            logger.error(`Failed to start project runtime: ${projectId}`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Update subscription after a runtime has been removed
     */
    private async updateSubscriptionAfterRuntimeRemoved(projectId: string): Promise<void> {
        if (!this.subscriptionManager) return;

        try {
            // Rebuild agent pubkey mapping without the removed project
            this.agentPubkeyToProjects.forEach((projectSet, agentPubkey) => {
                projectSet.delete(projectId);
                // If this agent no longer belongs to any project, remove it
                if (projectSet.size === 0) {
                    this.agentPubkeyToProjects.delete(agentPubkey);
                }
            });

            // Collect all agent pubkeys and definition IDs from remaining active runtimes
            const { pubkeys: allAgentPubkeys, definitionIds: allAgentDefinitionIds } =
                this.collectAgentData();

            this.subscriptionManager.updateAgentPubkeys(Array.from(allAgentPubkeys));
            this.subscriptionManager.updateAgentDefinitionIds(Array.from(allAgentDefinitionIds));
        } catch (error) {
            logger.error("Failed to update subscription after runtime removed", {
                projectId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Stop the daemon
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            logger.warn("Daemon is not running");
            return;
        }


        this.isRunning = false;

        // Stop streaming socket
        if (this.streamTransport) {
            await this.streamTransport.stop();
            streamPublisher.setTransport(null);
            this.streamTransport = null;
        }

        // Stop subscription
        if (this.subscriptionManager) {
            this.subscriptionManager.stop();
        }

        // Stop all active project runtimes
        if (this.runtimeLifecycle) {
            await this.runtimeLifecycle.stopAllRuntimes();
        }

        // Clear state
        this.knownProjects.clear();

        // Release lockfile
        if (this.lockfile) {
            await this.lockfile.release();
        }

        // Shutdown conversation span manager
        const conversationSpanManager = getConversationSpanManager();
        conversationSpanManager.shutdown();

    }
}

// Singleton instance
let daemonInstance: Daemon | null = null;

/**
 * Get or create the daemon instance
 */
export function getDaemon(): Daemon {
    if (!daemonInstance) {
        daemonInstance = new Daemon();
    }
    return daemonInstance;
}
