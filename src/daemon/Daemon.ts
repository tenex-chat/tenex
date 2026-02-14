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
import { ConversationStore } from "@/conversations/ConversationStore";
import { InterventionService, type AgentResolutionResult } from "@/services/intervention";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { RestartState } from "./RestartState";

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

    // Graceful restart state
    private pendingRestart = false;
    private restartInProgress = false;
    private restartState: RestartState | null = null;
    private supervisedMode = false;

    // Projects pending auto-boot from restart state (populated by loadRestartState, consumed by handleProjectEvent)
    private pendingRestartBootProjects: Set<string> = new Set();

    // Shutdown function (set by setupShutdownHandlers, used by triggerGracefulRestart)
    private shutdownFn: ((exitCode?: number, isGracefulRestart?: boolean) => Promise<void>) | null = null;

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
     * Enable supervised mode for graceful restart support.
     * In supervised mode:
     * - SIGHUP triggers deferred restart instead of immediate shutdown
     * - Daemon waits for all RALs to complete before exiting
     * - Booted projects are persisted for auto-boot on restart
     */
    setSupervisedMode(supervised: boolean): void {
        this.supervisedMode = supervised;
        logger.info("Supervised mode configured", { supervised });
    }

    /**
     * Check if daemon is in supervised mode
     */
    isSupervisedMode(): boolean {
        return this.supervisedMode;
    }

    /**
     * Check if a restart is pending
     */
    isPendingRestart(): boolean {
        return this.pendingRestart;
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

            // 12. Initialize InterventionService (after projects are loaded)
            // This must happen after subscriptions start so agent slugs can be resolved
            logger.debug("Initializing intervention service");
            const interventionService = InterventionService.getInstance();

            // Wire the agent resolver - allows InterventionService (Layer 3) to resolve agents
            // per-project without depending on @/daemon (Layer 4)
            interventionService.setAgentResolver(this.createAgentResolver());

            await interventionService.initialize();

            // 13. Initialize restart state manager
            logger.debug("Initializing restart state manager");
            this.restartState = new RestartState(this.daemonDir);

            // 14. Setup RAL completion listener for graceful restart
            if (this.supervisedMode) {
                this.setupRALCompletionListener();
            }

            // 15. Setup graceful shutdown
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

            // Check for intervention triggers (completion or user response)
            await this.checkInterventionTriggers(event, runtime, projectId);
        } catch (error) {
            logger.error("Project runtime crashed", { projectId, eventId: event.id });
            await this.runtimeLifecycle.handleRuntimeCrash(projectId, runtime);
            throw error; // Re-throw to mark span as error
        }
    }

    /**
     * Check if an event triggers intervention logic.
     *
     * Completion detection:
     * - Event is kind:1
     * - Event author is an agent (not whitelisted user)
     * - Event p-tags a whitelisted pubkey
     * - That whitelisted pubkey is the author of the root event for this conversation
     *
     * User response detection:
     * - Event is kind:1
     * - Event author is a whitelisted user
     * - Event is a reply in an existing conversation
     */
    private async checkInterventionTriggers(
        event: NDKEvent,
        runtime: ProjectRuntime,
        projectId: string
    ): Promise<void> {
        const interventionService = InterventionService.getInstance();
        if (!interventionService.isEnabled()) {
            return;
        }

        // Only process kind:1 events
        if (event.kind !== 1) {
            return;
        }

        const context = runtime.getContext();
        if (!context) {
            return;
        }

        const eventTimestamp = (event.created_at || 0) * 1000; // Convert to ms

        // Get conversation ID from the event (e-tag or reply target)
        const replyTarget = AgentEventDecoder.getReplyTarget(event);
        if (!replyTarget) {
            // This is a root event, not a reply - no intervention needed
            return;
        }

        // Find the conversation for this event
        const conversation = ConversationStore.findByEventId(replyTarget);
        if (!conversation) {
            // Conversation not found - can't determine root author
            return;
        }

        const conversationId = conversation.id || replyTarget;
        const rootAuthorPubkey = conversation.getRootAuthorPubkey();
        if (!rootAuthorPubkey) {
            return;
        }

        // Set the project context for InterventionService per-event
        // This ensures the service loads/saves state for the correct project
        // Must await to prevent race conditions during project switch:
        // - setProject flushes pending writes before updating currentProjectId
        // - If not awaited, onUserResponse/onAgentCompletion could run under wrong project
        try {
            await interventionService.setProject(projectId);
        } catch (error) {
            logger.error("Failed to set intervention project context", {
                projectId: projectId.substring(0, 12),
                error: error instanceof Error ? error.message : String(error),
            });
            // Continue processing - intervention is optional, don't block event handling
        }

        const isUserEvent = this.whitelistedPubkeys.includes(event.pubkey);
        const isAgentEvent = this.agentPubkeyToProjects.has(event.pubkey);

        if (isUserEvent) {
            // User response - potentially cancel intervention timer
            interventionService.onUserResponse(
                conversationId,
                eventTimestamp,
                event.pubkey
            );
        } else if (isAgentEvent) {
            // Check if agent is p-tagging the root author (completion signal)
            const pTags = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
            const pTagsRootAuthor = pTags.includes(rootAuthorPubkey);

            if (pTagsRootAuthor) {
                // Agent completed work and notified the user
                // Find the last user message timestamp in the conversation
                // This is used to determine if the user was recently active
                // We look for messages from the root author (conversation owner), not all whitelisted users
                const messages = conversation.getAllMessages();
                let lastUserMessageTime: number | undefined;
                for (let i = messages.length - 1; i >= 0; i--) {
                    const msg = messages[i];
                    if (msg.pubkey === rootAuthorPubkey) {
                        if (msg.timestamp) {
                            // Convert from seconds to ms
                            lastUserMessageTime = msg.timestamp * 1000;
                            break;
                        }
                        // Message from root author without timestamp - continue searching
                    }
                }

                interventionService.onAgentCompletion(
                    conversationId,
                    eventTimestamp,
                    event.pubkey,
                    rootAuthorPubkey,
                    projectId,
                    lastUserMessageTime
                );
            }
        }
    }

    /**
     * Create an agent resolver function for InterventionService.
     * This allows Layer 3 (InterventionService) to resolve agents per-project
     * without directly depending on Layer 4 (Daemon).
     *
     * Returns a function that:
     * - Returns { status: "resolved", pubkey } when agent is found
     * - Returns { status: "runtime_unavailable" } when project runtime not active (transient)
     * - Returns { status: "agent_not_found" } when agent slug doesn't exist (permanent)
     */
    private createAgentResolver(): (projectId: string, agentSlug: string) => AgentResolutionResult {
        return (projectId: string, agentSlug: string): AgentResolutionResult => {
            // Get active runtimes
            const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes();
            if (!activeRuntimes) {
                // RuntimeLifecycle not initialized - transient failure
                return { status: "runtime_unavailable" };
            }

            // Find the runtime for this project
            const runtime = activeRuntimes.get(projectId);
            if (!runtime) {
                // Runtime not active for this project - transient failure
                // (Project might not be booted yet, or was stopped)
                return { status: "runtime_unavailable" };
            }

            // Get the project context
            const context = runtime.getContext();
            if (!context) {
                // Context not available - transient failure
                return { status: "runtime_unavailable" };
            }

            // Look up the agent by slug in the project's agent registry
            const agent = context.agentRegistry.getAgent(agentSlug);
            if (!agent) {
                // Agent slug not found in this project - permanent failure
                return { status: "agent_not_found" };
            }

            // Successfully resolved
            return { status: "resolved", pubkey: agent.pubkey };
        };
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
                    // Clear any pending restart boot entry since we've successfully started
                    this.pendingRestartBootProjects.delete(projectId);
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

        // Auto-boot projects from restart state when they are discovered or retried
        // Drop the isNewProject guard: already-known projects that failed to boot in loadRestartState
        // need another chance when their project event is re-processed
        if (!runtime && this.pendingRestartBootProjects.has(projectId)) {
            if (this.runtimeLifecycle) {
                const projectTitle = project.tagValue("title") || event.tags.find((t) => t[0] === "d")?.[1] || "untitled";
                logger.info("Auto-booting project from restart state (deferred)", {
                    projectId,
                    projectTitle,
                });

                try {
                    runtime = await this.runtimeLifecycle.startRuntime(projectId, project);
                    await this.updateSubscriptionWithProjectAgents(projectId, runtime);
                    this.pendingRestartBootProjects.delete(projectId);
                    logger.info("Auto-booted project from restart state (deferred) successfully", {
                        projectId,
                        projectTitle,
                        remainingPending: this.pendingRestartBootProjects.size,
                    });
                } catch (error) {
                    logger.error("Failed to auto-boot project from restart state (deferred)", {
                        projectId,
                        projectTitle,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    // Remove from pending to avoid repeated failures
                    this.pendingRestartBootProjects.delete(projectId);
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
        /**
         * Perform graceful shutdown of the daemon.
         * @param exitCode - Exit code to use (default: 0)
         * @param isGracefulRestart - If true, persist restart state before shutdown
         */
        const shutdown = async (exitCode: number = 0, isGracefulRestart: boolean = false): Promise<void> => {
            if (isGracefulRestart) {
                console.log("\n[Daemon] Triggering graceful restart...");
            } else {
                console.log("\nShutting down gracefully...");
            }

            if (!this.isRunning) {
                process.exit(exitCode);
            }

            this.isRunning = false;

            try {
                // Persist booted projects for auto-boot on restart (only for graceful restart)
                if (isGracefulRestart && this.restartState && this.runtimeLifecycle) {
                    const bootedProjects = this.runtimeLifecycle.getActiveProjectIds();
                    await this.restartState.save(bootedProjects);
                    console.log(`[Daemon] Saved ${bootedProjects.length} booted project(s) for restart`);
                }

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

                // Stop intervention service
                process.stdout.write("Stopping intervention service...");
                InterventionService.getInstance().shutdown();
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

                if (isGracefulRestart) {
                    console.log("[Daemon] Graceful restart complete - exiting with code 0");
                } else {
                    console.log("Shutdown complete.");
                }
                process.exit(exitCode);
            } catch (error) {
                logger.error("Error during shutdown", { error });
                process.exit(1);
            }
        };

        // Store shutdown function for use by triggerGracefulRestart
        this.shutdownFn = shutdown;

        // SIGHUP handler - deferred restart in supervised mode, immediate shutdown otherwise
        const handleSighup = async (): Promise<void> => {
            if (this.supervisedMode) {
                // Ignore duplicate SIGHUP if restart is already pending or in progress
                if (this.pendingRestart || this.restartInProgress) {
                    logger.info("[Daemon] SIGHUP received but restart already pending/in progress, ignoring");
                    console.log("Restart already pending, ignoring duplicate SIGHUP");
                    return;
                }

                this.pendingRestart = true;
                const activeRalCount = RALRegistry.getInstance().getTotalActiveCount();

                console.log("\n[Daemon] SIGHUP received - initiating deferred restart");
                logger.info("[Daemon] SIGHUP received - initiating deferred restart", {
                    activeRalCount,
                });

                // If no active RALs, trigger restart immediately
                if (activeRalCount === 0) {
                    console.log("[Daemon] No active RALs, triggering immediate graceful restart");
                    await this.triggerGracefulRestart();
                } else {
                    console.log(`[Daemon] Waiting for ${activeRalCount} active RAL(s) to complete before restart...`);
                    // The RAL completion listener will trigger restart when count hits 0
                }
            } else {
                // Non-supervised mode: immediate shutdown
                shutdown();
            }
        };

        process.on("SIGTERM", () => shutdown());
        process.on("SIGINT", () => shutdown());
        process.on("SIGHUP", () => handleSighup());

        // Handle uncaught exceptions - exit with code 1 to trigger crash counter
        process.on("uncaughtException", (error) => {
            logger.error("Uncaught exception", {
                error: error.message,
                stack: error.stack,
            });
            // Use exit code 1 to indicate a crash, not a graceful restart
            // This ensures the wrapper's crash counter is incremented
            shutdown(1);
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
     * Setup listener for RAL completion events to trigger deferred restart.
     * Called when supervised mode is enabled.
     */
    private setupRALCompletionListener(): void {
        const ralRegistry = RALRegistry.getInstance();

        // Subscribe to RAL updates
        ralRegistry.on("updated", (_projectId: string, _conversationId: string) => {
            // Only check if restart is pending
            if (!this.pendingRestart) {
                return;
            }

            const activeRalCount = ralRegistry.getTotalActiveCount();
            logger.debug("[Daemon] RAL update received during pending restart", {
                activeRalCount,
            });

            // When count hits 0, trigger graceful restart
            if (activeRalCount === 0) {
                console.log("[Daemon] All RALs completed, triggering graceful restart");
                this.triggerGracefulRestart().catch((error) => {
                    logger.error("[Daemon] Failed to trigger graceful restart", {
                        error: error instanceof Error ? error.message : String(error),
                    });
                    process.exit(1);
                });
            }
        });

        logger.debug("[Daemon] RAL completion listener registered for supervised mode");
    }

    /**
     * Trigger graceful restart: persist state and exit cleanly.
     * The wrapper process will respawn the daemon.
     */
    private async triggerGracefulRestart(): Promise<void> {
        // Guard against concurrent calls (race condition from multiple RAL updates)
        if (this.restartInProgress) {
            logger.debug("[Daemon] Graceful restart already in progress, ignoring duplicate trigger");
            return;
        }
        this.restartInProgress = true;

        // Use the unified shutdown function with graceful restart flag
        if (this.shutdownFn) {
            await this.shutdownFn(0, true);
        } else {
            // Fallback if shutdown function not yet initialized (shouldn't happen)
            logger.error("[Daemon] Shutdown function not initialized, exiting with code 0");
            process.exit(0);
        }
    }

    /**
     * Add a custom shutdown handler
     */
    addShutdownHandler(handler: () => Promise<void>): void {
        this.shutdownHandlers.push(handler);
    }

    /**
     * Load restart state and queue previously booted projects for auto-boot.
     * Called after daemon is fully initialized to restore state from a graceful restart.
     *
     * Note: Projects may not be discovered yet via SubscriptionManager, so we store
     * the project IDs and attempt to boot them when they are discovered in handleProjectEvent.
     */
    async loadRestartState(): Promise<void> {
        if (!this.restartState) {
            return;
        }

        const state = await this.restartState.load();
        if (!state) {
            return;
        }

        console.log(`[Daemon] Found restart state from ${new Date(state.requestedAt).toISOString()}`);
        console.log(`[Daemon] Queuing ${state.bootedProjects.length} project(s) for auto-boot from restart state`);

        // Store projects to boot - they will be booted when discovered via handleProjectEvent
        this.pendingRestartBootProjects = new Set(state.bootedProjects);

        // Attempt to boot any projects that are already known
        // (This handles the case where some projects were discovered before loadRestartState was called)
        let bootedCount = 0;

        for (const projectId of state.bootedProjects) {
            const project = this.knownProjects.get(projectId);
            if (!project) {
                // Project not yet discovered - will be booted when discovered
                logger.debug("[Daemon] Project from restart state not yet discovered, deferring boot", {
                    projectId: projectId.substring(0, 20),
                });
                continue;
            }

            if (!this.runtimeLifecycle) {
                logger.error("[Daemon] RuntimeLifecycle not initialized during restart state loading");
                break;
            }

            // Already running? Skip
            if (this.runtimeLifecycle.getRuntime(projectId)) {
                this.pendingRestartBootProjects.delete(projectId);
                continue;
            }

            try {
                const runtime = await this.runtimeLifecycle.startRuntime(projectId, project);
                await this.updateSubscriptionWithProjectAgents(projectId, runtime);
                this.pendingRestartBootProjects.delete(projectId);
                bootedCount++;
                logger.info("[Daemon] Auto-booted project from restart state", {
                    projectId: projectId.substring(0, 20),
                });
            } catch (error) {
                logger.error("[Daemon] Failed to auto-boot project from restart state", {
                    projectId: projectId.substring(0, 20),
                    error: error instanceof Error ? error.message : String(error),
                });
                // Keep in pending set - will retry when project event is re-processed in handleProjectEvent
            }
        }

        // Clear restart state file now that we've loaded it
        // (Pending boots are tracked in memory via pendingRestartBootProjects)
        await this.restartState.clear();

        const pendingCount = this.pendingRestartBootProjects.size;
        if (pendingCount > 0) {
            console.log(`[Daemon] Restart state loaded: ${bootedCount} booted immediately, ${pendingCount} pending discovery`);
        } else {
            console.log(`[Daemon] Restart state processed: ${bootedCount} booted`);
        }
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

        // Stop intervention service
        InterventionService.getInstance().shutdown();

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
