import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import { agentStorage } from "@/agents/AgentStorage";
import { getReplyTarget, classifyForDaemon, isConfigUpdate } from "@/nostr/AgentEventDecoder";
import { publishBackendProfile } from "@/nostr/AgentProfilePublisher";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { prefixKVStore } from "@/services/storage";
import { Lockfile } from "@/utils/lockfile";
import { logger } from "@/utils/logger";
import type { ProjectDTag } from "@/types/project-ids";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKProject } from "@nostr-dev-kit/ndk";
import { context as otelContext, trace, type Span } from "@opentelemetry/api";
import { getConversationSpanManager } from "@/telemetry/ConversationSpanManager";
import type { RoutingDecision } from "./routing/DaemonRouter";
import {
    shouldTraceEvent,
    isAgentEvent,
    hasPTagsToSystemEntities,
    determineTargetProject,
} from "./routing/DaemonRouter";
import type { ProjectRuntime } from "./ProjectRuntime";
import { RuntimeLifecycle } from "./RuntimeLifecycle";
import { SubscriptionManager } from "./SubscriptionManager";
import type { DaemonStatus } from "./types";
import { createEventSpan, endSpanSuccess, endSpanError, addRoutingEvent } from "./utils/telemetry";
import { logDropped, logRouted } from "./utils/routing-log";
import { getConversationIndexingJob } from "@/conversations/search/embeddings";
import { NDKKind } from "@/nostr/kinds";
import { RAGService } from "@/services/rag/RAGService";
import { ConversationStore } from "@/conversations/ConversationStore";
import {
    InterventionService,
    type AgentResolutionResult,
    type ActiveDelegationCheckerFn,
} from "@/services/intervention";
import { Nip46SigningService } from "@/services/nip46";
import { SkillWhitelistService } from "@/services/skill";
import { RemoteBackendStatusService } from "@/services/status/RemoteBackendStatusService";
import { OwnerAgentListService } from "@/services/OwnerAgentListService";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { SkillService } from "@/services/skill";
import { RestartState } from "./RestartState";
import { StatusFile } from "./StatusFile";
import { AgentDefinitionMonitor } from "@/services/AgentDefinitionMonitor";
import { APNsService } from "@/services/apns";
import { getTrustPubkeyService } from "@/services/trust-pubkeys";
import { InstalledAgentListService } from "@/services/status/InstalledAgentListService";
import { ShutdownCoordinator } from "./ShutdownCoordinator";
import { SubscriptionSyncCoordinator } from "./SubscriptionSyncCoordinator";
import { EventHandlerRegistry } from "./EventHandlerRegistry";

/**
 * Main daemon that manages all projects in a single process.
 * Uses lazy loading - projects only start when they receive events.
 *
 * This class orchestrates the following focused coordinators:
 * - ShutdownCoordinator: Signal handling, graceful shutdown/restart
 * - SubscriptionSyncCoordinator: Keep Nostr subscriptions in sync with agents
 * - EventHandlerRegistry: Discrete event type handlers (project, lesson, etc.)
 * - RuntimeLifecycle: Runtime management (start/stop/restart)
 * - DaemonRouter: Event routing decisions
 */
export class Daemon {
    private ndk: NDK | null = null;
    private subscriptionManager: SubscriptionManager | null = null;
    private routingLogger: EventRoutingLogger;
    private whitelistedPubkeys: Hexpubkey[] = [];
    private backendPubkey: Hexpubkey | null = null;
    private projectsBase = "";
    private daemonDir = "";
    private isRunning = false;
    private shutdownHandlers: Array<() => Promise<void>> = [];
    private lockfile: Lockfile | null = null;

    // Runtime management delegated to RuntimeLifecycle
    private runtimeLifecycle: RuntimeLifecycle | null = null;

    // Project management — keyed by d-tag (ProjectDTag)
    private knownProjects = new Map<ProjectDTag, NDKProject>();

    // Agent pubkey mapping for routing (pubkey -> project d-tags)
    private agentPubkeyToProjects = new Map<Hexpubkey, Set<ProjectDTag>>();

    // Agent pubkeys seeded from AgentStorage at startup (covers not-yet-running projects)
    private storedAgentPubkeys = new Set<Hexpubkey>();

    // Auto-boot patterns - projects whose d-tag contains any of these patterns will be auto-started
    private autoBootPatterns: string[] = [];

    // Agent definition auto-upgrade monitor
    private agentDefinitionMonitor: AgentDefinitionMonitor | null = null;

    // Graceful restart state
    private pendingRestart = false;
    private restartInProgress = false;
    private restartState: RestartState | null = null;
    private supervisedMode = false;

    // Projects pending auto-boot from restart state (populated by loadRestartState, consumed by handleProjectEvent)
    private pendingRestartBootProjects: Set<ProjectDTag> = new Set();

    // Background-mode readiness signaling
    private readyCallback: (() => void) | null = null;
    private pendingAutoBootCount = 0;
    private staticEoseReceived = false;
    private fullyInitialized = false;
    private readyFired = false;
    private removeWhitelistCacheListener: (() => void) | null = null;

    // Status file for `tenex daemon status`
    private statusFile: StatusFile | null = null;
    private statusInterval: NodeJS.Timeout | null = null;
    private installedAgentListPublisher: InstalledAgentListService | null = null;

    // Focused coordinators (initialized in start() before isRunning = true)
    private shutdownCoordinator: ShutdownCoordinator | undefined;
    private subscriptionSyncCoordinator: SubscriptionSyncCoordinator | undefined;
    private eventHandlerRegistry: EventHandlerRegistry | undefined;

    private getSubscriptionSyncCoordinator(): SubscriptionSyncCoordinator {
        if (!this.subscriptionSyncCoordinator) {
            throw new Error("SubscriptionSyncCoordinator not initialized — call start() first");
        }
        return this.subscriptionSyncCoordinator;
    }

    private getEventHandlerRegistry(): EventHandlerRegistry {
        if (!this.eventHandlerRegistry) {
            throw new Error("EventHandlerRegistry not initialized — call start() first");
        }
        return this.eventHandlerRegistry;
    }

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
     * Register a callback to invoke once the daemon is ready.
     * "Ready" means the static subscription EOSE has been received and all
     * auto-boot projects have finished starting (or attempting to start).
     * Used by background-fork mode to signal the parent process.
     */
    setReadyCallback(cb: () => void): void {
        this.readyCallback = cb;
    }

    /**
     * Called by the command layer after all initialization (including scheduler) is complete.
     * This is the final gate before the ready callback can fire.
     * Also starts the periodic status writer.
     */
    markFullyInitialized(): void {
        this.fullyInitialized = true;
        this.writeStatus();
        this.statusInterval = setInterval(() => {
            this.writeStatus();
        }, 60_000);
        this.statusInterval.unref();
        this.checkReady();
    }

    private writeStatus(): void {
        if (!this.statusFile) return;
        const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
        const runtimes = Array.from(activeRuntimes.values()).map((runtime) => {
            const s = runtime.getStatus();
            return {
                projectId: s.projectId,
                title: s.title,
                agentCount: s.agentCount,
                startTime: s.startTime?.toISOString() ?? null,
                lastEventTime: s.lastEventTime?.toISOString() ?? null,
                eventCount: s.eventCount,
            };
        });
        const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
        this.statusFile
            .write({
                pid: process.pid,
                startedAt,
                knownProjects: this.knownProjects.size,
                runtimes,
                updatedAt: new Date().toISOString(),
            })
            .catch((err) =>
                logger.warn("Failed to write status file", {
                    error: err instanceof Error ? err.message : String(err),
                })
            );
    }

    private onStaticEose(): void {
        this.staticEoseReceived = true;
        this.checkReady();
    }

    private checkReady(): void {
        if (this.readyFired || !this.readyCallback) return;
        if (this.fullyInitialized && this.staticEoseReceived && this.pendingAutoBootCount === 0) {
            this.readyFired = true;
            // Reclaim transient allocations from the startup burst
            (globalThis as { Bun?: { gc: (sync: boolean) => void } }).Bun?.gc(true);
            this.readyCallback();
        }
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
            this.statusFile = new StatusFile(this.daemonDir);

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
                throw new Error("No whitelisted pubkeys configured. Run 'tenex onboard' first.");
            }

            // 4b. Run migrations if needed
            logger.debug("Checking for pending migrations");
            const { migrationService } = await import("@/services/migrations");
            const currentVersion = loadedConfig.version ?? 0;
            const latestVersion = migrationService.getLatestVersion();
            if (currentVersion < latestVersion) {
                logger.info("[Daemon] Running migrations", {
                    currentVersion,
                    latestVersion,
                });
                const migrationSummary = await migrationService.migrate();
                logger.info("[Daemon] Migrations completed", {
                    applied: migrationSummary.applied.length,
                    finalVersion: migrationSummary.finalVersion,
                });
            } else {
                logger.debug("[Daemon] No migrations needed", { currentVersion, latestVersion });
            }

            // 5. Get NDK instance (already initialized by daemon command)
            this.ndk = getNDK();

            // 6. Set backend signer on NDK for NIP-42 relay auth + publish profile
            logger.debug("Publishing backend profile");
            const backendSigner = await config.getBackendSigner();
            this.ndk.signer = backendSigner;
            this.backendPubkey = backendSigner.pubkey;
            const backendName = loadedConfig.backendName || "tenex backend";
            await publishBackendProfile(backendSigner, backendName, this.whitelistedPubkeys);

            // 6b. Initialize NIP-46 signing service (lazy — signers created on first use)
            if (loadedConfig.nip46?.enabled) {
                logger.info("NIP-46 remote signing enabled");
            }

            // 6c. Initialize OwnerAgentListService (global 14199 management)
            const nip46Service = Nip46SigningService.getInstance();
            const ownerAgentListPubkeys = nip46Service.isEnabled()
                ? [...this.whitelistedPubkeys]
                : [];
            OwnerAgentListService.getInstance().initialize(ownerAgentListPubkeys);

            // 6d. Initialize SkillWhitelistService
            const whitelistService = SkillWhitelistService.getInstance();
            this.removeWhitelistCacheListener?.();
            this.removeWhitelistCacheListener = whitelistService.onCacheUpdated(async () => {
                await this.hydrateWhitelistedSkillsToLocalStore();
            });
            whitelistService.initialize([...this.whitelistedPubkeys]);
            void this.hydrateWhitelistedSkillsToLocalStore();

            // 7. Initialize runtime lifecycle manager
            logger.debug("Initializing runtime lifecycle manager");
            this.runtimeLifecycle = new RuntimeLifecycle(this.projectsBase);

            // Initialize coordinators now that dependencies are available
            this.subscriptionSyncCoordinator = new SubscriptionSyncCoordinator({
                getRuntimeLifecycle: () => this.runtimeLifecycle,
                getSubscriptionManager: () => this.subscriptionManager,
                getStoredAgentPubkeys: () => this.storedAgentPubkeys,
                addStoredAgentPubkey: (pubkey) => this.storedAgentPubkeys.add(pubkey),
                getAgentPubkeyToProjects: () => this.agentPubkeyToProjects,
                clearAgentPubkeyToProjects: () => this.agentPubkeyToProjects.clear(),
                setAgentPubkeyInProjects: (pubkey, projects) =>
                    this.agentPubkeyToProjects.set(pubkey, projects),
            });

            this.eventHandlerRegistry = new EventHandlerRegistry({
                getNdk: () => this.ndk,
                getBackendPubkey: () => this.backendPubkey,
                getWhitelistedPubkeys: () => this.whitelistedPubkeys,
                getKnownProjects: () => this.knownProjects,
                getAutoBootPatterns: () => this.autoBootPatterns,
                getRuntimeLifecycle: () => this.runtimeLifecycle,
                getSubscriptionSyncCoordinator: () => this.getSubscriptionSyncCoordinator(),
                buildProjectAddressesForSubscription: () =>
                    this.buildProjectAddressesForSubscription(),
                updateKnownProjectsSubscription: (addresses) =>
                    this.subscriptionManager?.updateKnownProjects(addresses),
                onAutoBootStarted: () => {
                    this.pendingAutoBootCount++;
                },
                onAutoBootFinished: () => {
                    this.pendingAutoBootCount--;
                    this.checkReady();
                },
                getPendingRestartBootProjects: () => this.pendingRestartBootProjects,
                killRuntime: (projectId) => this.killRuntime(projectId),
            });

            this.shutdownCoordinator = new ShutdownCoordinator({
                getIsRunning: () => this.isRunning,
                setIsRunning: (running) => {
                    this.isRunning = running;
                },
                getRestartState: () => this.restartState,
                getRuntimeLifecycle: () => this.runtimeLifecycle,
                getAgentDefinitionMonitor: () => this.agentDefinitionMonitor,
                setAgentDefinitionMonitor: (monitor) => {
                    this.agentDefinitionMonitor = monitor;
                },
                getInstalledAgentListPublisher: () => this.installedAgentListPublisher,
                setInstalledAgentListPublisher: (publisher) => {
                    this.installedAgentListPublisher = publisher;
                },
                getSubscriptionManager: () => this.subscriptionManager,
                getShutdownHandlers: () => this.shutdownHandlers,
                getLockfile: () => this.lockfile,
                getSupervisedMode: () => this.supervisedMode,
                getPendingRestart: () => this.pendingRestart,
                setPendingRestart: (pending) => {
                    this.pendingRestart = pending;
                },
                getRestartInProgress: () => this.restartInProgress,
                setRestartInProgress: (inProgress) => {
                    this.restartInProgress = inProgress;
                },
            });

            // 8. Initialize subscription manager (before discovery)
            logger.debug("Initializing subscription manager");
            this.subscriptionManager = new SubscriptionManager(
                this.ndk,
                this.handleIncomingEvent.bind(this),
                this.whitelistedPubkeys,
                this.routingLogger,
                this.onStaticEose.bind(this)
            );

            // 8b. Seed trust service with all known agent pubkeys from storage
            await agentStorage.initialize();
            this.storedAgentPubkeys = await agentStorage.getAllKnownPubkeys();
            if (this.storedAgentPubkeys.size > 0) {
                getTrustPubkeyService().setGlobalAgentPubkeys(this.storedAgentPubkeys);
                logger.info("Seeded trust service with stored agent pubkeys", {
                    count: this.storedAgentPubkeys.size,
                });
            }

            // 9. Start subscription immediately
            logger.debug("Starting subscription manager");
            await this.subscriptionManager.start();
            logger.debug("Subscription manager started");

            this.installedAgentListPublisher = new InstalledAgentListService();
            await this.installedAgentListPublisher.startPublishing();
            logger.debug("Installed-agent inventory publisher started");

            // 10. Start automatic conversation indexing job
            getConversationIndexingJob().start();
            logger.info("Automatic conversation indexing job started");

            // 11. Initialize InterventionService
            logger.debug("Initializing intervention service");
            const interventionService = InterventionService.getInstance();
            interventionService.setAgentResolver(this.createAgentResolver());
            interventionService.setActiveDelegationChecker(this.createActiveDelegationChecker());
            await interventionService.initialize();

            // 11b. Initialize APNs push notification service
            logger.debug("Initializing APNs service");
            await APNsService.getInstance().initialize();

            // 12. Initialize restart state manager
            logger.debug("Initializing restart state manager");
            this.restartState = new RestartState(this.daemonDir);

            // 13. Setup RAL completion listener for graceful restart
            if (this.supervisedMode) {
                this.shutdownCoordinator.setupRALCompletionListener();
            }

            // 14. Start agent definition monitor for auto-upgrades
            logger.debug("Starting agent definition monitor");
            this.agentDefinitionMonitor = new AgentDefinitionMonitor(
                this.ndk,
                { whitelistedPubkeys: this.whitelistedPubkeys },
                () => this.runtimeLifecycle?.getActiveRuntimes() || new Map()
            );
            await this.agentDefinitionMonitor.start();
            logger.info("Agent definition monitor started");

            // 15. Setup graceful shutdown
            this.shutdownCoordinator.setupShutdownHandlers();

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

    private async hydrateWhitelistedSkillsToLocalStore(): Promise<void> {
        const whitelistedSkills = SkillWhitelistService.getInstance().getWhitelistedSkills();

        if (whitelistedSkills.length === 0) {
            return;
        }

        const requestedSkillIds = [...new Set(whitelistedSkills.map((skill) => skill.eventId))];
        const result = await SkillService.getInstance().fetchSkills(requestedSkillIds);

        logger.info("[Daemon] Synced whitelisted skills to local store", {
            requestedCount: requestedSkillIds.length,
            loadedCount: result.skills.length,
        });
    }

    /**
     * Initialize required directories for daemon operations
     */
    private async initializeDirectories(): Promise<void> {
        this.daemonDir = config.getConfigPath("daemon");

        const dirs = [
            this.daemonDir,
            path.join(this.daemonDir, "logs"),
            config.getConfigPath("agents"),
        ];

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
     * Build NIP-33 addresses from known projects for Nostr subscription filters.
     */
    private buildProjectAddressesForSubscription(): string[] {
        const addresses: string[] = [];
        for (const project of this.knownProjects.values()) {
            addresses.push(project.tagId());
        }
        return addresses;
    }

    /**
     * Handle incoming events from the subscription (telemetry wrapper)
     */
    private async handleIncomingEvent(event: NDKEvent): Promise<void> {
        if (event.kind === NDKKind.TenexProjectStatus) {
            RemoteBackendStatusService.getInstance().handleStatusEvent(
                event,
                this.backendPubkey ?? undefined
            );
            return;
        }

        const knownAgentPubkeys = new Set(this.agentPubkeyToProjects.keys());
        const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
        if (
            !shouldTraceEvent(
                event,
                this.knownProjects,
                knownAgentPubkeys,
                this.whitelistedPubkeys,
                activeRuntimes,
                this.backendPubkey ?? undefined
            )
        ) {
            return;
        }

        // Drop agent events without p-tags silently
        const isRootEvent = !getReplyTarget(event);
        if (
            isAgentEvent(event, this.agentPubkeyToProjects) &&
            !hasPTagsToSystemEntities(event, this.whitelistedPubkeys, this.agentPubkeyToProjects) &&
            !isRootEvent
        ) {
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
    private async processIncomingEvent(event: NDKEvent, span: Span): Promise<void> {
        const eventType = classifyForDaemon(event);

        if (eventType === "project") {
            addRoutingEvent(span, "project_event", { reason: "kind_31933" });
            await this.getEventHandlerRegistry().handleProjectEvent(event);
            await logDropped(this.routingLogger, event, "Project creation/update event");
            return;
        }

        if (eventType === "lesson") {
            addRoutingEvent(span, "lesson_event", { reason: "kind_4129" });
            await this.getEventHandlerRegistry().handleLessonEvent(event);
            await logDropped(
                this.routingLogger,
                event,
                "Lesson event - hydrated into active runtimes only"
            );
            return;
        }

        if (eventType === "lesson_comment") {
            addRoutingEvent(span, "lesson_comment_event", { reason: "kind_1111_K_4129" });
            await this.getEventHandlerRegistry().handleLessonCommentEvent(event);
            await logDropped(
                this.routingLogger,
                event,
                "Lesson comment - hydrated into active runtimes only"
            );
            return;
        }

        if (eventType === "agent_create") {
            addRoutingEvent(span, "agent_create", { reason: "kind_24001" });
            await this.getEventHandlerRegistry().handleAgentCreateRequest(event);
            await logDropped(
                this.routingLogger,
                event,
                "Handled backend-targeted agent create request"
            );
            return;
        }

        if (isConfigUpdate(event) && !event.tagValue("a")) {
            addRoutingEvent(span, "agent_config_global", { reason: "kind_24020_no_a_tag" });
            await this.getEventHandlerRegistry().handleGlobalAgentConfigUpdate(event);
            return;
        }

        // Determine target project
        const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes() || new Map();
        const routingResult = determineTargetProject(
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
            method: routingResult.method,
        });

        await this.routeEventToProject(event, routingResult, span);
    }

    /**
     * Route event to a specific project
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

        let runtime = this.runtimeLifecycle.getRuntime(projectId);

        if (!runtime) {
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

            try {
                addRoutingEvent(span, "project_runtime_start", {
                    title: project.tagValue("title") || "untitled",
                    bootKind: event.kind,
                });
                runtime = await this.runtimeLifecycle.startRuntime(projectId, project);
                await this.getSubscriptionSyncCoordinator().updateSubscriptionWithProjectAgents(
                    projectId,
                    runtime
                );
            } catch (error) {
                logger.error("Failed to start runtime", { projectId, error });
                await logDropped(this.routingLogger, event, "Failed to start runtime");
                return;
            }
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

        try {
            if (!event.id) {
                throw new Error("Event ID not found");
            }
            await runtime.handleEvent(event);
            await this.checkInterventionTriggers(event, runtime, projectId);
        } catch (error) {
            logger.error("Project runtime crashed", { projectId, eventId: event.id });
            await this.runtimeLifecycle.handleRuntimeCrash(projectId, runtime);
            throw error;
        }
    }

    /**
     * Check if an event triggers intervention logic.
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

        if (event.kind !== 1) {
            return;
        }

        const context = runtime.getContext();
        if (!context) {
            return;
        }

        const eventTimestamp = (event.created_at || 0) * 1000;

        const replyTarget = getReplyTarget(event);
        if (!replyTarget) {
            return;
        }

        const conversation = ConversationStore.findByEventId(replyTarget);
        if (!conversation) {
            return;
        }

        const conversationId = conversation.id || replyTarget;
        const rootAuthorPubkey = conversation.getRootAuthorPubkey();
        if (!rootAuthorPubkey) {
            return;
        }

        const isUserEvent = this.whitelistedPubkeys.includes(event.pubkey);

        if (!isUserEvent) {
            return;
        }

        try {
            await interventionService.setProject(projectId);
        } catch (error) {
            logger.error("Failed to set intervention project context", {
                projectId: projectId.substring(0, 12),
                error: error instanceof Error ? error.message : String(error),
            });
        }

        interventionService.onUserResponse(conversationId, eventTimestamp, event.pubkey);
    }

    /** Create an agent resolver for InterventionService */
    private createAgentResolver(): (projectId: string, agentSlug: string) => AgentResolutionResult {
        return (projectId: string, agentSlug: string): AgentResolutionResult => {
            const activeRuntimes = this.runtimeLifecycle?.getActiveRuntimes();
            if (!activeRuntimes) {
                return { status: "runtime_unavailable" };
            }

            const runtime = activeRuntimes.get(projectId as ProjectDTag);
            if (!runtime) {
                return { status: "runtime_unavailable" };
            }

            const context = runtime.getContext();
            if (!context) {
                return { status: "runtime_unavailable" };
            }

            const agent = context.agentRegistry.getAgent(agentSlug);
            if (!agent) {
                return { status: "agent_not_found" };
            }

            return { status: "resolved", pubkey: agent.pubkey };
        };
    }

    /**
     * Create an active delegation checker function for InterventionService.
     */
    private createActiveDelegationChecker(): ActiveDelegationCheckerFn {
        return (agentPubkey: string, conversationId: string): boolean => {
            const pendingDelegations = RALRegistry.getInstance().getConversationPendingDelegations(
                agentPubkey,
                conversationId
            );
            return pendingDelegations.length > 0;
        };
    }

    /**
     * Add a custom shutdown handler
     */
    addShutdownHandler(handler: () => Promise<void>): void {
        this.shutdownHandlers.push(handler);
    }

    /**
     * Load restart state and queue previously booted projects for auto-boot.
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
        console.log(
            `[Daemon] Queuing ${state.bootedProjects.length} project(s) for auto-boot from restart state`
        );

        this.pendingRestartBootProjects = new Set(state.bootedProjects);

        let bootedCount = 0;

        for (const projectId of state.bootedProjects) {
            const project = this.knownProjects.get(projectId);
            if (!project) {
                logger.debug("[Daemon] Project from restart state not yet discovered, deferring boot", {
                    projectId: projectId.substring(0, 20),
                });
                continue;
            }

            if (!this.runtimeLifecycle) {
                logger.error("[Daemon] RuntimeLifecycle not initialized during restart state loading");
                break;
            }

            if (this.runtimeLifecycle.getRuntime(projectId)) {
                this.pendingRestartBootProjects.delete(projectId);
                continue;
            }

            try {
                const runtime = await this.runtimeLifecycle.startRuntime(projectId, project);
                await this.getSubscriptionSyncCoordinator().updateSubscriptionWithProjectAgents(
                    projectId,
                    runtime
                );
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
            }
        }

        await this.restartState.clear();

        const pendingCount = this.pendingRestartBootProjects.size;
        if (pendingCount > 0) {
            console.log(
                `[Daemon] Restart state loaded: ${bootedCount} booted immediately, ${pendingCount} pending discovery`
            );
        } else {
            console.log(`[Daemon] Restart state processed: ${bootedCount} booted`);
        }
    }

    /**
     * Get daemon status
     */
    getStatus(): DaemonStatus {
        let totalAgents = 0;
        for (const project of this.knownProjects.values()) {
            const agentTags = project.tags.filter((t) => t[0] === "p");
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
    getKnownProjects(): Map<ProjectDTag, NDKProject> {
        return this.knownProjects;
    }

    /**
     * Get active runtimes
     */
    getActiveRuntimes(): Map<ProjectDTag, ProjectRuntime> {
        return this.runtimeLifecycle?.getActiveRuntimes() || new Map();
    }

    /**
     * Kill a specific project runtime
     */
    async killRuntime(projectId: ProjectDTag): Promise<void> {
        if (!this.runtimeLifecycle) {
            throw new Error("RuntimeLifecycle not initialized");
        }

        try {
            await this.runtimeLifecycle.stopRuntime(projectId);
            await this.getSubscriptionSyncCoordinator().updateSubscriptionAfterRuntimeRemoved(
                projectId
            );
        } catch (error) {
            logger.error(`Failed to kill project runtime: ${projectId}`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Restart a specific project runtime
     */
    async restartRuntime(projectId: ProjectDTag): Promise<void> {
        if (!this.runtimeLifecycle) {
            throw new Error("RuntimeLifecycle not initialized");
        }

        const project = this.knownProjects.get(projectId);
        if (!project) {
            throw new Error(`Project not found: ${projectId}`);
        }

        try {
            const runtime = await this.runtimeLifecycle.restartRuntime(projectId, project);
            await this.getSubscriptionSyncCoordinator().updateSubscriptionWithProjectAgents(
                projectId,
                runtime
            );
        } catch (error) {
            logger.error(`Failed to restart project runtime: ${projectId}`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Start a specific project runtime
     */
    async startRuntime(projectId: ProjectDTag): Promise<void> {
        if (!this.runtimeLifecycle) {
            throw new Error("RuntimeLifecycle not initialized");
        }

        const project = this.knownProjects.get(projectId);
        if (!project) {
            throw new Error(`Project not found: ${projectId}`);
        }

        try {
            const runtime = await this.runtimeLifecycle.startRuntime(projectId, project);
            await this.getSubscriptionSyncCoordinator().updateSubscriptionWithProjectAgents(
                projectId,
                runtime
            );
        } catch (error) {
            logger.error(`Failed to start project runtime: ${projectId}`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
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

        getConversationIndexingJob().stop();
        RAGService.closeInstance();
        InterventionService.getInstance().shutdown();
        OwnerAgentListService.getInstance().shutdown();

        this.removeWhitelistCacheListener?.();
        this.removeWhitelistCacheListener = null;

        SkillWhitelistService.getInstance().shutdown();
        await Nip46SigningService.getInstance().shutdown();

        if (this.subscriptionManager) {
            this.subscriptionManager.stop();
        }

        if (this.runtimeLifecycle) {
            await this.runtimeLifecycle.stopAllRuntimes();
        }

        await prefixKVStore.forceClose();
        this.knownProjects.clear();

        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
        await this.statusFile?.remove();

        if (this.lockfile) {
            await this.lockfile.release();
        }

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
