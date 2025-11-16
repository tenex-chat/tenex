import type { NDKEvent, Hexpubkey } from "@nostr-dev-kit/ndk";
import NDK, { NDKProject } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { logger } from "@/utils/logger";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { configService } from "@/services";
import { SubscriptionManager } from "./SubscriptionManager";
import { ProjectRuntime } from "./ProjectRuntime";
import { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { trace, propagation, context as otelContext, ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import { getConversationSpanManager } from "@/telemetry/ConversationSpanManager";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { Lockfile } from "@/utils/lockfile";

const tracer = trace.getTracer("tenex.daemon");

/**
 * Event kinds that should never be routed to projects.
 * These events are informational or transient and don't require processing.
 */
const NEVER_ROUTE_EVENT_KINDS = [
    NDKKind.TenexProjectStatus,
    NDKKind.TenexStreamingResponse,
    NDKKind.TenexAgentTypingStart,
    NDKKind.TenexAgentTypingStop,
    NDKKind.TenexOperationsStatus,
];

/**
 * Main daemon that manages all projects in a single process.
 * Uses lazy loading - projects only start when they receive events.
 */
export class Daemon {
  private ndk: NDK | null = null;
  private subscriptionManager: SubscriptionManager | null = null;
  private routingLogger: EventRoutingLogger;
  private whitelistedPubkeys: Hexpubkey[] = [];
  private projectsBase: string = "";
  private daemonDir: string = "";
  private isRunning = false;
  private shutdownHandlers: Array<() => Promise<void>> = [];
  private lockfile: Lockfile | null = null;

  // Project management
  private knownProjects = new Map<string, NDKProject>(); // All discovered projects
  private activeRuntimes = new Map<string, ProjectRuntime>(); // Only active projects
  private startingRuntimes = new Map<string, Promise<ProjectRuntime>>(); // Projects currently being started

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
        whitelistedPubkeys: this.whitelistedPubkeys.map(p => p.slice(0, 8)),
        projectsBase: this.projectsBase,
      });

      // 5. Initialize NDK
      await initNDK();
      this.ndk = getNDK();

      // 6. Initialize subscription manager (before discovery)
      this.subscriptionManager = new SubscriptionManager(
        this.ndk,
        this.handleIncomingEvent.bind(this), // Pass event handler
        this.whitelistedPubkeys,
        this.routingLogger
      );

      // 7. Discover existing projects (but don't start them)
      // This will update the subscription manager with projects and agents
      await this.discoverProjects();

      // 8. Start subscription (now it has projects and agents)
      await this.subscriptionManager.start();

      // 9. Setup graceful shutdown
      this.setupShutdownHandlers();

      this.isRunning = true;

      logger.debug("TENEX Daemon started successfully", {
        knownProjects: this.knownProjects.size,
        activeProjects: this.activeRuntimes.size,
      });

    } catch (error) {
      logger.error("Failed to start daemon", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Release lockfile on startup failure
      if (this.lockfile) {
        await this.lockfile.release().catch(releaseError => {
          logger.warn("Failed to release lockfile during error cleanup", {
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
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

    const dirs = [
      this.daemonDir,
      path.join(this.daemonDir, "logs"),
    ];

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
   * Discover existing projects from Nostr (but don't start them)
   * Uses subscribe() with EOSE to wait for initial load, but keeps subscription active
   * for continuous updates
   */
  private async discoverProjects(): Promise<void> {
    logger.debug("Discovering existing projects from whitelisted pubkeys");

    const ndk = getNDK();

    // Use subscribe instead of fetchEvents to get initial projects + continuous updates
    return new Promise<void>((resolve, reject) => {
      const subscription = ndk.subscribe(
        {
          kinds: [31933],
          authors: this.whitelistedPubkeys,
        },
        {
          closeOnEose: true, // Close after initial load since SubscriptionManager will handle ongoing updates
        }
      );

      subscription.on("event", (event: NDKEvent) => {
        try {
          const projectId = this.buildProjectId(event);
          const project = NDKProject.from(event);
          this.knownProjects.set(projectId, project);

          logger.debug(`Discovered project: ${projectId}`, {
            title: project.tagValue("title"),
          });
        } catch (error) {
          logger.error("Failed to process project", {
            error: error instanceof Error ? error.message : String(error),
            eventId: event.id,
          });
        }
      });

      subscription.on("eose", () => {
        logger.debug(`Found ${this.knownProjects.size} projects during initial discovery`);

        // Update subscription manager with discovered projects
        const projectIds = Array.from(this.knownProjects.keys());

        if (this.subscriptionManager) {
          this.subscriptionManager.updateKnownProjects(projectIds);
          // Agent pubkeys will be added when projects start and load their agents
        }

        logger.debug("Known projects updated", {
          old: 0,
          new: this.knownProjects.size,
        });

        resolve();
      });

      // Add error handling
      subscription.on("close", () => {
        logger.debug("Project discovery subscription closed after EOSE");
      });

      // Set a timeout to prevent hanging forever
      const timeout = setTimeout(() => {
        logger.warn("Project discovery timed out after 30s");
        subscription.stop();
        resolve(); // Resolve anyway, we'll work with what we got
      }, 30000);

      subscription.on("eose", () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Build project ID from event
   */
  private buildProjectId(event: NDKEvent): string {
    const dTag = event.tags.find(t => t[0] === "d")?.[1];
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
    if (event.kind && NEVER_ROUTE_EVENT_KINDS.includes(event.kind)) {
      await this.processDroppedEvent(event, `Event kind ${event.kind} is in NEVER_ROUTE_EVENT_KINDS`);
      return;
    }

    // Extract trace context from event tags if present (for delegation linking)
    const traceContextTag = event.tags.find(t => t[0] === "trace_context");
    let parentContext = ROOT_CONTEXT;
    if (traceContextTag) {
      const carrier = { "traceparent": traceContextTag[1] };
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
    return otelContext.with(
      trace.setSpan(otelContext.active(), span),
      async () => {
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
      }
    );
  }

  /**
   * Process incoming event (pure business logic, telemetry-free)
   */
  private async processIncomingEvent(event: NDKEvent, span: ReturnType<typeof tracer.startSpan>): Promise<void> {
    // Handle project events (kind 31933)
    if (event.kind === 31933) {
      span.addEvent("routing_decision", { "decision": "project_event", "reason": "kind_31933" });
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

    // Filter out events published BY agents unless they explicitly p-tag someone in the system
    if (this.isAgentEvent(event) && !this.hasPTagsToSystemEntities(event)) {
      span.addEvent("routing_decision", { "decision": "dropped", "reason": "agent_event_without_p_tags" });
      await this.processDroppedEvent(event, "Agent event without p-tags to system entities");
      return;
    }

    // Determine target project
    const routingResult = await this.determineTargetProject(event);
    if (!routingResult.projectId) {
      span.addEvent("routing_decision", { "decision": "dropped", "reason": routingResult.reason });
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
    routingResult: { projectId: string; method: "a_tag" | "p_tag_agent" | "none"; matchedTags: string[] },
    span: ReturnType<typeof tracer.startSpan>
  ): Promise<void> {
    const projectId = routingResult.projectId;

    // Get or start the project runtime
    let runtime = this.activeRuntimes.get(projectId);
    let runtimeAction: "existing" | "started" = "existing";

    if (!runtime) {
      // Check if this project is currently being started
      const startingPromise = this.startingRuntimes.get(projectId);
      if (startingPromise) {
        runtime = await startingPromise;
      } else {
        // Start the project runtime
        const project = this.knownProjects.get(projectId);
        if (!project) {
          span.addEvent("error", { "error": "unknown_project" });
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

        // Start the project runtime lazily
        const projectTitle = project.tagValue("title");
        span.addEvent("project_runtime_start", { "project.title": projectTitle || "untitled" });

        // Create startup promise to prevent concurrent startups
        const startupPromise = (async () => {
          const newRuntime = new ProjectRuntime(project, this.projectsBase);
          await newRuntime.start();
          return newRuntime;
        })();

        this.startingRuntimes.set(projectId, startupPromise);

        try {
          runtime = await startupPromise;
          this.activeRuntimes.set(projectId, runtime);
          runtimeAction = "started";

          // Update subscription with this project's agent pubkeys
          await this.updateSubscriptionWithProjectAgents(projectId, runtime);
        } finally {
          this.startingRuntimes.delete(projectId);
        }
      }
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
      this.activeRuntimes.delete(projectId);
      await runtime.stop().catch(() => {}); // Best effort cleanup
      throw error; // Re-throw to mark span as error
    }
  }

  /**
   * Collect all agent pubkeys and definition IDs from active runtimes
   */
  private collectAgentData(): { pubkeys: Set<Hexpubkey>; definitionIds: Set<string> } {
    const pubkeys = new Set<Hexpubkey>();
    const definitionIds = new Set<string>();

    for (const [pid, rt] of this.activeRuntimes) {
      const context = rt.getContext();
      if (!context) {
        throw new Error(`Runtime for project ${pid} has no context during agent collection`);
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
  private async updateSubscriptionWithProjectAgents(projectId: string, _runtime: ProjectRuntime): Promise<void> {
    if (!this.subscriptionManager) return;

    try {
      const { pubkeys: allAgentPubkeys, definitionIds: allAgentDefinitionIds } = this.collectAgentData();

      // Track which projects each agent belongs to
      for (const [pid, rt] of this.activeRuntimes) {
        const context = rt.getContext();
        if (!context) {
          throw new Error(`Runtime for project ${pid} has no context during subscription update`);
        }

        const agents = context.agentRegistry.getAllAgents();
        for (const agent of agents) {
          if (!this.agentPubkeyToProjects.has(agent.pubkey)) {
            this.agentPubkeyToProjects.set(agent.pubkey, new Set());
          }

          const projectSet = this.agentPubkeyToProjects.get(agent.pubkey);
          if (!projectSet) {
            throw new Error(`Agent pubkey ${agent.pubkey.slice(0, 8)} missing from agentPubkeyToProjects after set`);
          }
          projectSet.add(pid);
        }
      }

      logger.debug("Updating subscription with agent data from active projects", {
        activeProjects: this.activeRuntimes.size,
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
    const runtime = this.activeRuntimes.get(projectId);
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
   * Check if an event was published by an agent in the system
   */
  private isAgentEvent(event: NDKEvent): boolean {
    return this.agentPubkeyToProjects.has(event.pubkey);
  }

  /**
   * Check if an event has p-tags pointing to system entities (whitelisted pubkeys or other agents)
   */
  private hasPTagsToSystemEntities(event: NDKEvent): boolean {
    const pTags = event.tags.filter(t => t[0] === "p");

    for (const tag of pTags) {
      const pubkey = tag[1];
      if (!pubkey) {
        continue;
      }

      // Check if p-tag points to a whitelisted pubkey
      if (this.whitelistedPubkeys.includes(pubkey as Hexpubkey)) {
        return true;
      }

      // Check if p-tag points to another agent in the system
      if (this.agentPubkeyToProjects.has(pubkey as Hexpubkey)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Determine which project an event should be routed to
   */
  private async determineTargetProject(event: NDKEvent): Promise<{
    projectId: string | null;
    method: "a_tag" | "p_tag_agent" | "none";
    matchedTags: string[];
    reason: string;
  }> {
    // Check for explicit project A-tags
    const aTags = event.tags.filter(t => t[0] === "A" || t[0] === "a");
    const projectATags = aTags.filter(t => t[1]?.startsWith("31933:"));

    logger.debug("Checking A-tags for project routing", {
      eventId: event.id.slice(0, 8),
      aTagsFound: projectATags.length,
      aTags: projectATags.map(t => t[1]),
    });

    for (const tag of projectATags) {
      const aTagValue = tag[1];
      if (aTagValue && this.knownProjects.has(aTagValue)) {
        const project = this.knownProjects.get(aTagValue);
        if (!project) {
          throw new Error(`Project ${aTagValue} not found in knownProjects despite has() check`);
        }

        logger.info("Routing event to project via A-tag", {
          eventId: event.id.slice(0, 8),
          eventKind: event.kind,
          projectId: aTagValue,
          projectTitle: project.tagValue("title"),
        });

        return {
          projectId: aTagValue,
          method: "a_tag",
          matchedTags: [aTagValue],
          reason: `Matched project A-tag: ${aTagValue}`,
        };
      }
    }

    if (projectATags.length > 0) {
      logger.debug("A-tags found but no matching known projects", {
        eventId: event.id.slice(0, 8),
        projectATags: projectATags.map(t => t[1]),
        knownProjects: Array.from(this.knownProjects.keys()),
      });
    }

    // Check for agent P-tags (find project by agent pubkey)
    const pTags = event.tags.filter(t => t[0] === "p");

    logger.debug("Checking P-tags for agent routing", {
      eventId: event.id.slice(0, 8),
      pTagsFound: pTags.length,
      pTags: pTags.map(t => t[1]?.slice(0, 8)),
    });

    for (const tag of pTags) {
      const pubkey = tag[1];
      if (!pubkey) {
        continue;
      }

      // Check if this pubkey belongs to any active project's agents
      const projectIds = this.agentPubkeyToProjects.get(pubkey as Hexpubkey);
      if (projectIds && projectIds.size > 0) {
        // Use the first project (in practice, agents should belong to one project)
        const projectId = Array.from(projectIds)[0];

        const project = this.knownProjects.get(projectId);
        if (!project) {
          throw new Error(`Project ${projectId} not found in knownProjects despite being in agentPubkeyToProjects mapping`);
        }

        const runtime = this.activeRuntimes.get(projectId);
        if (!runtime) {
          throw new Error(`Runtime for project ${projectId} not found in activeRuntimes despite being in agentPubkeyToProjects mapping`);
        }

        // Get agent from runtime - it MUST exist since we found it in agentPubkeyToProjects
        const context = runtime.getContext();
        if (!context) {
          throw new Error(`Runtime for project ${projectId} has no context`);
        }

        const agent = context.agentRegistry.getAllAgents().find(a => a.pubkey === pubkey);
        if (!agent) {
          throw new Error(`Agent ${pubkey.slice(0, 8)} not found in project ${projectId} despite being in agentPubkeyToProjects mapping`);
        }

        logger.info("Routing event to project via agent P-tag", {
          eventId: event.id.slice(0, 8),
          eventKind: event.kind,
          projectId,
          projectTitle: project.tagValue("title"),
          agentPubkey: pubkey.slice(0, 8),
          agentSlug: agent.slug,
        });

        return {
          projectId,
          method: "p_tag_agent",
          matchedTags: [pubkey],
          reason: `Matched agent P-tag: ${pubkey.slice(0, 8)}`,
        };
      }
    }

    // No match found
    const reason =
      projectATags.length > 0 ? `A-tags found but no matching known projects: ${projectATags.map(t => t[1]).join(", ")}` :
      pTags.length > 0 ? `P-tags found but no matching agents: ${pTags.map(t => t[1]?.slice(0, 8)).join(", ")}` :
      "No A-tags or P-tags found";

    logger.debug("No project match found", {
      eventId: event.id.slice(0, 8),
      reason,
    });

    return {
      projectId: null,
      method: "none",
      matchedTags: [],
      reason,
    };
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
        for (const [projectId, runtime] of this.activeRuntimes) {
          logger.info(`Stopping project runtime: ${projectId}`);
          await runtime.stop().catch(error => {
            logger.error(`Error stopping project runtime: ${projectId}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        this.activeRuntimes.clear();

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
  getStatus(): {
    running: boolean;
    knownProjects: number;
    activeProjects: number;
    agents: number;
    uptime: number;
  } {
    // Count total agents across all known projects
    let totalAgents = 0;
    for (const project of this.knownProjects.values()) {
      const agentTags = project.tags.filter((t) => t[0] === "agent");
      totalAgents += agentTags.length;
    }

    return {
      running: this.isRunning,
      knownProjects: this.knownProjects.size,
      activeProjects: this.activeRuntimes.size,
      agents: totalAgents,
      uptime: process.uptime(),
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
    return this.activeRuntimes;
  }

  /**
   * Kill a specific project runtime
   * @param projectId - The project ID to kill
   * @throws Error if the runtime is not found or not running
   */
  async killRuntime(projectId: string): Promise<void> {
    const runtime = this.activeRuntimes.get(projectId);

    if (!runtime) {
      throw new Error(`Runtime not found: ${projectId}`);
    }

    logger.info(`Killing project runtime: ${projectId}`);

    try {
      await runtime.stop();
      this.activeRuntimes.delete(projectId);

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
    const runtime = this.activeRuntimes.get(projectId);

    if (!runtime) {
      throw new Error(`Runtime not found: ${projectId}`);
    }

    logger.info(`Restarting project runtime: ${projectId}`);

    try {
      // Stop the runtime
      await runtime.stop();

      // Start it again
      await runtime.start();

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
      const { pubkeys: allAgentPubkeys, definitionIds: allAgentDefinitionIds } = this.collectAgentData();

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
    for (const [projectId, runtime] of this.activeRuntimes) {
      await runtime.stop().catch(error => {
        logger.error(`Error stopping project runtime: ${projectId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Clear state
    this.activeRuntimes.clear();
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
    daemonInstance.stop().catch(error => {
      logger.error("Error stopping daemon during reset", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  daemonInstance = null;
}