import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import type { AgentInstance } from "@/agents/types";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { AgentProfilePublisher } from "@/nostr/AgentProfilePublisher";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { prefixKVStore } from "@/services/storage";
import { Lockfile } from "@/utils/lockfile";
import { shouldTrustLesson } from "@/utils/lessonTrust";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKProject } from "@nostr-dev-kit/ndk";
import { context as otelContext, trace, type Span } from "@opentelemetry/api";
import { getConversationSpanManager } from "@/telemetry/ConversationSpanManager";
import { shutdownTelemetry } from "@/telemetry/setup";
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
import { getConversationIndexingJob } from "@/conversations/search/embeddings";

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

    // Auto-boot patterns - projects whose d-tag contains any of these patterns will be auto-started
    private autoBootPatterns: string[] = [];

    constructor() {
        this.routingLogger = new EventRoutingLogger();
    }

    /**
     * Set patterns for auto-booting projects on discovery
     * Projects whose d-tag contains any of these patterns will be auto-started
     */
    setAutoBootPatterns(patterns: string[]): void {
        this.autoBootPatterns = patterns;
        logger.info("Auto-boot patterns configured", { patterns });
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
            logger.debug("Initializing base directories");
            await this.initializeDirectories();

            // 2. Acquire lockfile to prevent multiple daemon instances
            logger.debug("Acquiring daemon lock");
            await this.acquireDaemonLock();

            // 3. Initialize routing logger
            logger.debug("Initializing routing logger");
            this.routingLogger.initialize(this.daemonDir);

            // 4. Load configuration
            logger.debug("Loading configuration");
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
            logger.debug("Initializing NDK (again)");
            await initNDK();
            this.ndk = getNDK();

            // 6. Publish backend profile (kind:0)
            logger.debug("Publishing backend profile");
            const backendSigner = await config.getBackendSigner();
            const backendName = loadedConfig.backendName || "tenex backend";
            await AgentProfilePublisher.publishBackendProfile(backendSigner, backendName, this.whitelistedPubkeys);

            // 7. Initialize runtime lifecycle manager
            logger.debug("Initializing runtime lifecycle manager");
            this.runtimeLifecycle = new RuntimeLifecycle(this.projectsBase);

            // 8. Initialize subscription manager (before discovery)
            logger.debug("Initializing subscription manager");
            this.subscriptionManager = new SubscriptionManager(
                this.ndk,
                this.handleIncomingEvent.bind(this), // Pass event handler
                this.whitelistedPubkeys,
                this.routingLogger
            );

            // 9. Start subscription immediately
            // Projects will be discovered naturally as events arrive
            logger.debug("Starting subscription manager");
            await this.subscriptionManager.start();
            logger.debug("Subscription manager started");

            // 10. Start local streaming socket
            logger.debug("Starting local streaming socket");
            this.streamTransport = new UnixSocketTransport();
            await this.streamTransport.start();
            streamPublisher.setTransport(this.streamTransport);
            logger.info("Local streaming socket started", { path: this.streamTransport.getSocketPath() });

            // 11. Start automatic conversation indexing job
            getConversationIndexingJob().start();
            logger.info("Automatic conversation indexing job started");

            // 12. Setup graceful shutdown
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
        // Check if this daemon should trace this event at all.
        // This prevents noisy traces when multiple backends are running.
        // Only trace events we'll actually process:
        // - Project events from whitelisted authors (for discovery)
        // - Other events only if we have a runtime OR can boot one
        const knownAgentPubkeys = new Set(this.agentPubkeyToProjects.keys());
        const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
        if (
            !DaemonRouter.shouldTraceEvent(
                event,
                this.knownProjects,
                knownAgentPubkeys,
                this.whitelistedPubkeys,
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
                    throw new Error("Event ID not found", { cause: error });
                }
                if (!event.id) {
                    throw new Error("Event ID not found", { cause: error });
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

        // Handle lesson comment events (kind 1111 with #K: ["4129"])
        if (eventType === "lesson_comment") {
            addRoutingEvent(span, "lesson_comment_event", { reason: "kind_1111_K_4129" });
            await this.handleLessonCommentEvent(event);
            await logDropped(this.routingLogger, event, "Lesson comment - routed to prompt compilers");
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
     * Update subscription with agent pubkeys and definition IDs from all active runtimes.
     * Also sets up the onAgentAdded callback to keep routing synchronized when
     * agents are created dynamically via agents_write tool.
     */
    private async updateSubscriptionWithProjectAgents(
        projectId: string,
        runtime: ProjectRuntime
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

            // Set up callback for dynamic agent additions (e.g., via agents_write tool)
            // This ensures new agents are immediately routable without requiring a restart
            const context = runtime.getContext();
            if (context) {
                context.setOnAgentAdded((agent) => {
                    this.handleDynamicAgentAdded(projectId, agent);
                });
            }
        } catch (error) {
            logger.error("Failed to update subscription with project agents", {
                projectId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Handle a dynamically added agent (e.g., created via agents_write tool).
     * Updates the routing map and subscription to make the agent immediately routable.
     */
    private handleDynamicAgentAdded(projectId: string, agent: AgentInstance): void {
        // Add to routing map
        if (!this.agentPubkeyToProjects.has(agent.pubkey)) {
            this.agentPubkeyToProjects.set(agent.pubkey, new Set());
        }
        const projectSet = this.agentPubkeyToProjects.get(agent.pubkey);
        if (projectSet) {
            projectSet.add(projectId);
        }

        // Update subscription with the new pubkey
        if (this.subscriptionManager) {
            const allPubkeys = Array.from(this.agentPubkeyToProjects.keys());
            this.subscriptionManager.updateAgentPubkeys(allPubkeys);

            // Also update definition IDs if this agent has one
            if (agent.eventId) {
                const { definitionIds } = this.collectAgentData();
                this.subscriptionManager.updateAgentDefinitionIds(Array.from(definitionIds));
            }
        }

        logger.info("Dynamic agent added to routing", {
            projectId,
            agentSlug: agent.slug,
            agentPubkey: agent.pubkey.slice(0, 8),
        });
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
        let runtime = this.runtimeLifecycle?.getRuntime(projectId);
        if (runtime) {
            await runtime.handleEvent(event);
            await this.updateSubscriptionWithProjectAgents(projectId, runtime);
        }

        // Auto-boot newly discovered projects that match boot patterns
        if (isNewProject && !runtime && this.autoBootPatterns.length > 0) {
            const dTag = event.tags.find((t) => t[0] === "d")?.[1] || "";
            const matchingPattern = this.autoBootPatterns.find((pattern) =>
                dTag.toLowerCase().includes(pattern.toLowerCase())
            );

            if (matchingPattern && this.runtimeLifecycle) {
                const projectTitle = project.tagValue("title") || dTag;
                logger.info("Auto-booting project matching pattern", {
                    projectId,
                    projectTitle,
                    dTag,
                    matchedPattern: matchingPattern,
                });

                try {
                    runtime = await this.runtimeLifecycle.startRuntime(projectId, project);
                    await this.updateSubscriptionWithProjectAgents(projectId, runtime);
                    logger.info("Auto-booted project successfully", { projectId, projectTitle });
                } catch (error) {
                    logger.error("Failed to auto-boot project", {
                        projectId,
                        projectTitle,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
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
     * Handle lesson comment events (kind 1111 with #K: ["4129"])
     * Routes comments to the appropriate PromptCompilerService for prompt refinement.
     */
    private async handleLessonCommentEvent(event: NDKEvent): Promise<void> {
        const span = lessonTracer.startSpan("tenex.lesson_comment.received", {
            attributes: {
                "comment.event_id": event.id?.substring(0, 16) || "unknown",
                "comment.author": event.pubkey?.substring(0, 16) || "unknown",
                "comment.created_at": event.created_at || 0,
            },
        });

        try {
            // Verify author is whitelisted
            if (!this.whitelistedPubkeys.includes(event.pubkey)) {
                span.setAttribute("comment.rejected", true);
                span.setAttribute("comment.rejection_reason", "not_whitelisted");
                span.end();
                return;
            }

            // Extract the lesson event ID from the root 'e' tag
            const rootETag = event.tags.find(
                (tag) => tag[0] === "e" && tag[3] === "root"
            );
            const lessonEventId = rootETag?.[1] || event.tags.find((tag) => tag[0] === "e")?.[1];

            if (!lessonEventId) {
                span.setAttribute("comment.rejected", true);
                span.setAttribute("comment.rejection_reason", "no_lesson_reference");
                span.end();
                return;
            }

            span.setAttribute("comment.lesson_event_id", lessonEventId.substring(0, 16));

            // Get the agent pubkey from p-tag
            const agentPubkey = event.tagValue("p");
            if (!agentPubkey) {
                span.setAttribute("comment.rejected", true);
                span.setAttribute("comment.rejection_reason", "no_agent_reference");
                span.end();
                return;
            }

            span.setAttribute("comment.agent_pubkey", agentPubkey.substring(0, 16));

            // Route to active runtimes that have this agent
            const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
            let routedCount = 0;

            for (const [projectId, runtime] of activeRuntimes) {
                const context = runtime.getContext();
                if (!context) continue;

                const agent = context.getAgentByPubkey(agentPubkey);
                if (!agent) continue;

                // Get the PromptCompilerService for this agent
                const compiler = context.getPromptCompiler(agentPubkey);
                if (compiler) {
                    compiler.addComment({
                        id: event.id || "",
                        pubkey: event.pubkey,
                        content: event.content,
                        lessonEventId,
                        createdAt: event.created_at || 0,
                    });
                    routedCount++;

                    span.addEvent("comment_routed", {
                        "project.id": projectId,
                        "agent.slug": agent.slug,
                    });

                    logger.debug("Routed lesson comment to prompt compiler", {
                        projectId,
                        agentSlug: agent.slug,
                        commentId: event.id?.substring(0, 8),
                        lessonEventId: lessonEventId.substring(0, 8),
                    });
                } else {
                    // Log when routing is skipped due to missing compiler
                    logger.warn("Skipping lesson comment routing - no prompt compiler registered", {
                        projectId,
                        agentSlug: agent.slug,
                        agentPubkey: agentPubkey.substring(0, 8),
                        commentId: event.id?.substring(0, 8),
                    });

                    span.addEvent("comment_routing_skipped", {
                        "project.id": projectId,
                        "agent.slug": agent.slug,
                        "reason": "no_prompt_compiler",
                    });
                }
            }

            span.setAttribute("comment.routed_count", routedCount);
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
        const shutdown = async (): Promise<void> => {
            console.log("\nShutting down gracefully...");
            if (!this.isRunning) {
                process.exit(0);
            }

            this.isRunning = false;

            try {
                if (this.streamTransport) {
                    process.stdout.write("Stopping stream transport...");
                    await this.streamTransport.stop();
                    streamPublisher.setTransport(null);
                    this.streamTransport = null;
                    console.log(" done");
                }

                // Stop conversation indexing job
                process.stdout.write("Stopping conversation indexing job...");
                getConversationIndexingJob().stop();
                console.log(" done");

                if (this.subscriptionManager) {
                    process.stdout.write("Stopping subscriptions...");
                    this.subscriptionManager.stop();
                    console.log(" done");
                }

                if (this.runtimeLifecycle) {
                    const stats = this.runtimeLifecycle.getStats();
                    if (stats.activeCount > 0) {
                        console.log(`Stopping ${stats.activeCount} project runtime(s)...`);
                    }
                    await this.runtimeLifecycle.stopAllRuntimes();
                }

                // Close the global prefix KV store (after all runtimes are stopped)
                process.stdout.write("Closing storage...");
                await prefixKVStore.forceClose();
                console.log(" done");

                if (this.shutdownHandlers.length > 0) {
                    process.stdout.write("Running shutdown handlers...");
                    for (const handler of this.shutdownHandlers) {
                        await handler();
                    }
                    console.log(" done");
                }

                if (this.lockfile) {
                    await this.lockfile.release();
                }

                process.stdout.write("Flushing telemetry...");
                const conversationSpanManager = getConversationSpanManager();
                conversationSpanManager.shutdown();
                await shutdownTelemetry();
                console.log(" done");

                console.log("Shutdown complete.");
                process.exit(0);
            } catch (error) {
                logger.error("Error during shutdown", { error });
                process.exit(1);
            }
        };

        process.on("SIGTERM", () => shutdown());
        process.on("SIGINT", () => shutdown());
        process.on("SIGHUP", () => shutdown());

        // Handle uncaught exceptions
        process.on("uncaughtException", (error) => {
            logger.error("Uncaught exception", {
                error: error.message,
                stack: error.stack,
            });
            shutdown();
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

        // Stop conversation indexing job
        getConversationIndexingJob().stop();

        // Stop subscription
        if (this.subscriptionManager) {
            this.subscriptionManager.stop();
        }

        // Stop all active project runtimes
        if (this.runtimeLifecycle) {
            await this.runtimeLifecycle.stopAllRuntimes();
        }

        // Close the global prefix KV store (after all runtimes are stopped)
        await prefixKVStore.forceClose();

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
