import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { configService } from "@/services";
import { getConversationSpanManager } from "@/telemetry/ConversationSpanManager";
import { Lockfile } from "@/utils/lockfile";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKProject } from "@nostr-dev-kit/ndk";
import {
    ROOT_CONTEXT,
    SpanStatusCode,
    context as otelContext,
    propagation,
    trace,
} from "@opentelemetry/api";
import type { ProjectRuntime } from "./ProjectRuntime";
import { RuntimeLifecycle } from "./RuntimeLifecycle";
import { SubscriptionManager } from "./SubscriptionManager";
import { DaemonRouter } from "./routing/DaemonRouter";
import type { DaemonStatus } from "./types";
import { isDropped, isRoutedToProject } from "./types";

const tracer = trace.getTracer("tenex.daemon");

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

        logger.debug("Starting TENEX Daemon");

        try {
            // 1. Initialize base directories
            await this.initializeDirectories();

            // 2. Acquire lockfile to prevent multiple daemon instances
            await this.acquireDaemonLock();

            // 3. Initialize routing logger
            this.routingLogger.initialize(this.daemonDir);

            // 4. Load configuration
            const { config } = await configService.loadConfig();
            this.whitelistedPubkeys = config.whitelistedPubkeys || [];
            this.projectsBase = configService.getProjectsBase();

            if (this.whitelistedPubkeys.length === 0) {
                throw new Error("No whitelisted pubkeys configured. Run 'tenex setup' first.");
            }

            logger.debug("Loaded configuration", {
                whitelistedPubkeys: this.whitelistedPubkeys.map((p) => p.slice(0, 8)),
                projectsBase: this.projectsBase,
            });

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

            // 9. Setup graceful shutdown
            this.setupShutdownHandlers();

            this.isRunning = true;

            const stats = this.runtimeLifecycle?.getStats() || { activeCount: 0 };
            logger.debug("TENEX Daemon started successfully", {
                knownProjects: this.knownProjects.size,
                activeProjects: stats.activeCount,
            });
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
        this.daemonDir = path.join(os.homedir(), ".tenex", "daemon");

        const dirs = [this.daemonDir, path.join(this.daemonDir, "logs")];

        for (const dir of dirs) {
            await fs.mkdir(dir, { recursive: true });
        }

        logger.debug("Initialized daemon directories", { daemonDir: this.daemonDir });
    }

    /**
     * Acquire daemon lockfile to prevent multiple instances
     */
    private async acquireDaemonLock(): Promise<void> {
        this.lockfile = new Lockfile(Lockfile.getDefaultPath());
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
        // Never route certain event kinds - check this FIRST before creating telemetry traces
        if (AgentEventDecoder.isNeverRouteKind(event)) {
            await this.processDroppedEvent(
                event,
                `Event kind ${event.kind} is in NEVER_ROUTE_EVENT_KINDS`
            );
            return;
        }

        // Extract trace context from event tags if present (for delegation linking)
        const traceContextTag = event.tags.find((t) => t[0] === "trace_context");
        let parentContext = ROOT_CONTEXT;
        if (traceContextTag) {
            const carrier = { traceparent: traceContextTag[1] };
            parentContext = propagation.extract(ROOT_CONTEXT, carrier);
        }

        // Determine conversation ID for tagging
        const conversationSpanManager = getConversationSpanManager();
        let conversationId = AgentEventDecoder.getConversationRoot(event);
        if (!conversationId && event.id) {
            conversationId = event.id;
        }

        // Create telemetry span with conversation attributes
        const span = tracer.startSpan(
            "tenex.event.process",
            {
                attributes: {
                    "event.id": event.id,
                    "event.kind": event.kind || 0,
                    "event.pubkey": event.pubkey,
                    "event.created_at": event.created_at || 0,
                    "event.content": event.content,
                    "event.content_length": event.content.length,
                    "event.tags": JSON.stringify(event.tags),
                    "event.tag_count": event.tags.length,
                    "event.has_trace_context": !!traceContextTag,
                    // Add conversation tracking attributes
                    "conversation.id": conversationId || "unknown",
                    "conversation.is_root": !AgentEventDecoder.getConversationRoot(event),
                },
            },
            parentContext
        );

        // Track message sequence in conversation
        if (conversationId) {
            conversationSpanManager.incrementMessageCount(conversationId, span);
        }

        // Execute business logic within telemetry context
        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                await this.processIncomingEvent(event, span);
                span.setStatus({ code: SpanStatusCode.OK });
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                logger.error("Error handling incoming event", {
                    error: error instanceof Error ? error.message : String(error),
                    eventId: event.id,
                    eventKind: event.kind,
                });
            } finally {
                span.end();
            }
        });
    }

    /**
     * Process incoming event (pure business logic, telemetry-free)
     */
    private async processIncomingEvent(
        event: NDKEvent,
        span: ReturnType<typeof tracer.startSpan>
    ): Promise<void> {
        // Classify event type
        const eventType = AgentEventDecoder.classifyForDaemon(event);

        // Handle project events (kind 31933)
        if (eventType === "project") {
            span.addEvent("routing_decision", { decision: "project_event", reason: "kind_31933" });
            await this.handleProjectEvent(event);
            await this.routingLogger.logRoutingDecision({
                event,
                routingDecision: "project_event",
                targetProjectId: this.buildProjectId(event),
                routingMethod: "none",
                reason: "Project creation/update event",
            });
            return;
        }

        // Handle lesson events (kind 4129) - hydrate into ACTIVE runtimes only, don't start new ones
        if (eventType === "lesson") {
            span.addEvent("routing_decision", { decision: "lesson_event", reason: "kind_4129" });
            await this.handleLessonEvent(event);
            await this.routingLogger.logRoutingDecision({
                event,
                routingDecision: "lesson_hydration",
                targetProjectId: null,
                routingMethod: "none",
                reason: "Lesson event - hydrated into active runtimes only",
            });
            return;
        }

        // Filter out events published BY agents unless they explicitly p-tag someone in the system
        if (
            DaemonRouter.isAgentEvent(event, this.agentPubkeyToProjects) &&
            !DaemonRouter.hasPTagsToSystemEntities(event, this.whitelistedPubkeys, this.agentPubkeyToProjects)
        ) {
            span.addEvent("routing_decision", {
                decision: "dropped",
                reason: "agent_event_without_p_tags",
            });
            await this.processDroppedEvent(event, "Agent event without p-tags to system entities");
            return;
        }

        // Determine target project using DaemonRouter
        const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
        const routingResult = DaemonRouter.determineTargetProject(
            event,
            this.knownProjects,
            this.agentPubkeyToProjects,
            activeRuntimes
        );

        if (!routingResult.projectId) {
            span.addEvent("routing_decision", {
                decision: "dropped",
                reason: routingResult.reason,
            });
            await this.processDroppedEvent(event, routingResult.reason);
            return;
        }

        // Route to project
        span.setAttributes({
            "project.id": routingResult.projectId,
            "routing.decision": "route_to_project",
            "routing.method": routingResult.method,
        });

        await this.routeEventToProject(event, routingResult, span);
    }

    /**
     * Handle dropped events (business logic helper)
     */
    private async processDroppedEvent(event: NDKEvent, reason: string): Promise<void> {
        logger.debug("Dropping event", {
            eventId: event.id.slice(0, 8),
            kind: event.kind,
            reason,
        });
        await this.routingLogger.logRoutingDecision({
            event,
            routingDecision: "dropped",
            targetProjectId: null,
            routingMethod: "none",
            reason,
        });
    }

    /**
     * Route event to a specific project (business logic)
     */
    private async routeEventToProject(
        event: NDKEvent,
        routingResult: {
            projectId: string;
            method: "a_tag" | "p_tag_agent" | "none";
            matchedTags: string[];
        },
        span: ReturnType<typeof tracer.startSpan>
    ): Promise<void> {
        if (!this.runtimeLifecycle) {
            logger.error("RuntimeLifecycle not initialized");
            return;
        }

        const projectId = routingResult.projectId;

        // Get the project
        const project = this.knownProjects.get(projectId);
        if (!project) {
            span.addEvent("error", { error: "unknown_project" });
            logger.warn("Unknown project referenced", { projectId });
            await this.routingLogger.logRoutingDecision({
                event,
                routingDecision: "dropped",
                targetProjectId: projectId,
                routingMethod: routingResult.method,
                matchedTags: routingResult.matchedTags,
                reason: "Project not found in known projects",
            });
            return;
        }

        // Get or start the runtime using RuntimeLifecycle
        let runtimeAction: "existing" | "started" = "existing";
        let runtime;

        try {
            const existingRuntime = this.runtimeLifecycle.getRuntime(projectId);
            if (existingRuntime) {
                runtime = existingRuntime;
            } else {
                // Start the project runtime lazily
                const projectTitle = project.tagValue("title");
                span.addEvent("project_runtime_start", {
                    "project.title": projectTitle || "untitled",
                });

                runtime = await this.runtimeLifecycle.getOrStartRuntime(projectId, project);
                runtimeAction = "started";

                // Update subscription with this project's agent pubkeys
                await this.updateSubscriptionWithProjectAgents(projectId, runtime);
            }
        } catch (error) {
            logger.error("Failed to get/start runtime", {
                projectId,
                error: error instanceof Error ? error.message : String(error),
            });
            await this.routingLogger.logRoutingDecision({
                event,
                routingDecision: "dropped",
                targetProjectId: projectId,
                routingMethod: routingResult.method,
                matchedTags: routingResult.matchedTags,
                reason: "Failed to start runtime",
            });
            return;
        }

        // Log successful routing
        await this.routingLogger.logRoutingDecision({
            event,
            routingDecision: "routed",
            targetProjectId: projectId,
            routingMethod: routingResult.method,
            matchedTags: routingResult.matchedTags,
            runtimeAction,
        });

        // Handle the event with crash isolation
        try {
            await runtime.handleEvent(event);
        } catch (error) {
            span.recordException(error as Error);
            logger.error("Project runtime crashed while handling event", {
                projectId,
                eventId: event.id,
                error: error instanceof Error ? error.message : String(error),
            });
            // Project crashed, but daemon continues
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

            logger.debug("Updating subscription with agent data from active projects", {
                activeProjects: activeRuntimes.size,
                totalAgentPubkeys: allAgentPubkeys.size,
                totalAgentDefinitionIds: allAgentDefinitionIds.size,
            });

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

        logger.info("Processing project event", {
            projectId,
            title: project.tagValue("title"),
            isUpdate: !isNewProject,
            isNewProject,
        });

        // Update known projects
        this.knownProjects.set(projectId, project);

        // If this is a new project, update the subscription manager
        if (isNewProject && this.subscriptionManager) {
            logger.info("New project discovered, updating subscription manager", {
                projectId,
                title: project.tagValue("title"),
            });
            const projectIds = Array.from(this.knownProjects.keys());
            this.subscriptionManager.updateKnownProjects(projectIds);
        }

        // If project is active, route to runtime's EventHandler for incremental update
        const runtime = this.runtimeLifecycle?.getRuntime(projectId);
        if (runtime) {
            logger.info("Routing project update to runtime's EventHandler for incremental update");

            // Route the project event to the runtime's event handler
            // This will trigger incremental updates (add/remove agents, MCP tools, etc.)
            await runtime.handleEvent(event);

            // Update subscription with potentially new agent pubkeys
            await this.updateSubscriptionWithProjectAgents(projectId, runtime);
        }
    }

    /**
     * Handle lesson events (kind 4129) - hydrate into active runtimes only
     * Does NOT start new project runtimes
     */
    private async handleLessonEvent(event: NDKEvent): Promise<void> {
        const { NDKAgentLesson } = await import("@/events/NDKAgentLesson");
        const { shouldTrustLesson } = await import("@/utils/lessonTrust");

        const lesson = NDKAgentLesson.from(event);

        // Check if we should trust this lesson
        if (!shouldTrustLesson(lesson, event.pubkey)) {
            logger.debug("Lesson event rejected by trust check", {
                eventId: event.id?.substring(0, 8),
                publisher: event.pubkey?.substring(0, 8),
            });
            return;
        }

        const agentDefinitionId = lesson.agentDefinitionId;

        if (!agentDefinitionId) {
            logger.warn("Lesson event missing agent definition ID (e-tag)", {
                eventId: event.id?.substring(0, 8),
                publisher: event.pubkey?.substring(0, 8),
            });
            return;
        }

        // Hydrate lesson into ACTIVE runtimes only (don't start new ones)
        let hydratedCount = 0;

        const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
        for (const [projectId, runtime] of activeRuntimes) {
            try {
                const context = runtime.getContext();
                if (!context) {
                    continue;
                }

                // Find agents in this project that match the definition ID
                const matchingAgents = context.agentRegistry
                    .getAllAgents()
                    .filter((agent) => agent.eventId === agentDefinitionId);

                if (matchingAgents.length === 0) {
                    continue;
                }

                // Store the lesson for each matching agent
                for (const agent of matchingAgents) {
                    context.addLesson(agent.pubkey, lesson);
                    hydratedCount++;
                    logger.info("Stored lesson for agent", {
                        projectId: projectId.substring(0, 16),
                        agentSlug: agent.slug,
                        agentPubkey: agent.pubkey.substring(0, 8),
                        lessonTitle: lesson.title,
                        lessonId: event.id?.substring(0, 8),
                        publisher: event.pubkey?.substring(0, 8),
                    });
                }
            } catch (error) {
                logger.error("Failed to hydrate lesson into project", {
                    projectId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        if (hydratedCount === 0) {
            logger.debug("Lesson event not hydrated (no matching active runtimes)", {
                eventId: event.id?.substring(0, 8),
                agentDefinitionId: agentDefinitionId.substring(0, 8),
                activeRuntimeCount: activeRuntimes.size,
            });
        }
    }

    /**
     * Setup graceful shutdown handlers
     */
    private setupShutdownHandlers(): void {
        const shutdown = async (signal: string): Promise<void> => {
            logger.info(`Received ${signal}, starting graceful shutdown`);

            if (!this.isRunning) {
                logger.info("Daemon not running, exiting");
                process.exit(0);
            }

            this.isRunning = false;

            try {
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

                logger.info("Graceful shutdown complete");
                process.exit(0);
            } catch (error) {
                logger.error("Error during shutdown", {
                    error: error instanceof Error ? error.message : String(error),
                });
                process.exit(1);
            }
        };

        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));
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

        logger.info(`Killing project runtime: ${projectId}`);

        try {
            await this.runtimeLifecycle.stopRuntime(projectId);

            // Update subscription to remove this project's agent pubkeys
            await this.updateSubscriptionAfterRuntimeRemoved(projectId);

            logger.info(`Project runtime killed: ${projectId}`);
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

        logger.info(`Restarting project runtime: ${projectId}`);

        try {
            const runtime = await this.runtimeLifecycle.restartRuntime(projectId, project);

            // Update subscription with potentially new agent pubkeys
            await this.updateSubscriptionWithProjectAgents(projectId, runtime);

            logger.info(`Project runtime restarted: ${projectId}`);
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

        logger.info(`Starting project runtime: ${projectId}`, {
            title: project.tagValue("title"),
        });

        try {
            const runtime = await this.runtimeLifecycle.startRuntime(projectId, project);

            // Update subscription with this project's agent pubkeys
            await this.updateSubscriptionWithProjectAgents(projectId, runtime);

            logger.info(`Project runtime started: ${projectId}`);
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

            logger.debug("Updating subscription after runtime removed", {
                removedProject: projectId,
                remainingAgents: allAgentPubkeys.size,
                remainingDefinitions: allAgentDefinitionIds.size,
            });

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

        logger.info("Stopping daemon");

        this.isRunning = false;

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

        logger.info("Daemon stopped");
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

/**
 * Reset the daemon (mainly for testing)
 */
export function resetDaemon(): void {
    if (daemonInstance) {
        daemonInstance.stop().catch((error) => {
            logger.error("Error stopping daemon during reset", {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    daemonInstance = null;
}
