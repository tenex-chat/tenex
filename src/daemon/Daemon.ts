import type { NDKEvent, Hexpubkey } from "@nostr-dev-kit/ndk";
import NDK, { NDKProject } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { configService } from "@/services";
import { SubscriptionManager } from "./SubscriptionManager";
import { ProjectRuntime } from "./ProjectRuntime";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Main daemon that manages all projects in a single process.
 * Uses lazy loading - projects only start when they receive events.
 */
export class Daemon {
  private ndk: NDK | null = null;
  private subscriptionManager: SubscriptionManager | null = null;
  private whitelistedPubkeys: Hexpubkey[] = [];
  private isRunning = false;
  private shutdownHandlers: Array<() => Promise<void>> = [];

  // Project management
  private knownProjects = new Map<string, NDKProject>(); // All discovered projects
  private activeRuntimes = new Map<string, ProjectRuntime>(); // Only active projects

  /**
   * Initialize and start the daemon
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Daemon is already running");
      return;
    }

    logger.info("Starting TENEX Daemon");

    try {
      // 1. Initialize base directories
      await this.initializeDirectories();

      // 2. Load configuration
      const { config } = await configService.loadConfig();
      this.whitelistedPubkeys = config.whitelistedPubkeys || [];

      if (this.whitelistedPubkeys.length === 0) {
        throw new Error("No whitelisted pubkeys configured. Run 'tenex setup' first.");
      }

      logger.info("Loaded configuration", {
        whitelistedPubkeys: this.whitelistedPubkeys.map(p => p.slice(0, 8)),
      });

      // 3. Initialize NDK
      await initNDK();
      this.ndk = getNDK();

      // 4. Discover existing projects (but don't start them)
      await this.discoverProjects();

      // 5. Initialize subscription manager
      this.subscriptionManager = new SubscriptionManager(
        this.ndk,
        this.handleIncomingEvent.bind(this), // Pass event handler
        this.whitelistedPubkeys
      );

      // 6. Start subscription
      await this.subscriptionManager.start();

      // 7. Setup graceful shutdown
      this.setupShutdownHandlers();

      this.isRunning = true;

      logger.info("TENEX Daemon started successfully", {
        knownProjects: this.knownProjects.size,
        activeProjects: this.activeRuntimes.size,
      });

    } catch (error) {
      logger.error("Failed to start daemon", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Initialize required directories
   */
  private async initializeDirectories(): Promise<void> {
    const dirs = [
      ".tenex",
      ".tenex/projects",
      ".tenex/logs",
      ".tenex/daemon",
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }

    logger.debug("Initialized directories");
  }

  /**
   * Discover existing projects from Nostr (but don't start them)
   */
  private async discoverProjects(): Promise<void> {
    logger.info("Discovering existing projects from whitelisted pubkeys");

    const ndk = getNDK();
    const projectEvents = await ndk.fetchEvents({
      kinds: [31933],
      authors: this.whitelistedPubkeys,
    });

    logger.info(`Found ${projectEvents.size} projects`);

    // Just store project metadata, don't initialize
    for (const event of projectEvents) {
      try {
        const projectId = this.buildProjectId(event);
        const project = new NDKProject(ndk, event.rawEvent());
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
    }

    // Update subscription manager with discovered projects
    const projectIds = Array.from(this.knownProjects.keys());

    // Extract all agent pubkeys from all projects for subscription
    const allAgentPubkeys = new Set<Hexpubkey>();
    for (const project of this.knownProjects.values()) {
      const agentTags = project.tags.filter((t) => t[0] === "A" && t[1]?.startsWith("31990:"));
      for (const tag of agentTags) {
        const pubkey = tag[1]?.split(":")[1];
        if (pubkey) {
          allAgentPubkeys.add(pubkey as Hexpubkey);
        }
      }
    }

    if (this.subscriptionManager) {
      this.subscriptionManager.updateKnownProjects(projectIds);
      this.subscriptionManager.updateAgentPubkeys(Array.from(allAgentPubkeys));
    }
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
   * Handle incoming events from the subscription
   */
  private async handleIncomingEvent(event: NDKEvent): Promise<void> {
    try {
      // Handle project events (kind 31933)
      if (event.kind === 31933) {
        await this.handleProjectEvent(event);
        return;
      }

      // Determine target project
      const projectId = await this.determineTargetProject(event);
      if (!projectId) {
        logger.debug("Event has no target project, ignoring", {
          eventId: event.id.slice(0, 8),
          kind: event.kind,
        });
        return;
      }

      // Get or start the project runtime
      let runtime = this.activeRuntimes.get(projectId);
      if (!runtime) {
        const project = this.knownProjects.get(projectId);
        if (!project) {
          logger.warn("Unknown project referenced", { projectId });
          return;
        }

        // Start the project runtime lazily
        logger.info(`Starting project runtime on demand: ${projectId}`);
        runtime = new ProjectRuntime(project);

        await runtime.start();
        this.activeRuntimes.set(projectId, runtime);
      }

      // Handle the event with crash isolation
      try {
        await runtime.handleEvent(event);
      } catch (error) {
        logger.error(`Project runtime crashed while handling event`, {
          projectId,
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Project crashed, but daemon continues
        // Optionally remove the crashed runtime
        this.activeRuntimes.delete(projectId);
        await runtime.stop().catch(() => {}); // Best effort cleanup
      }
    } catch (error) {
      logger.error("Error handling incoming event", {
        error: error instanceof Error ? error.message : String(error),
        eventId: event.id,
        eventKind: event.kind,
      });
    }
  }

  /**
   * Handle project creation/update events
   */
  private async handleProjectEvent(event: NDKEvent): Promise<void> {
    const projectId = this.buildProjectId(event);
    const project = new NDKProject(getNDK(), event.rawEvent());

    logger.info("Processing project event", {
      projectId,
      title: project.tagValue("title"),
      isUpdate: this.knownProjects.has(projectId),
    });

    // Update known projects
    this.knownProjects.set(projectId, project);

    // If project is active, update it
    const runtime = this.activeRuntimes.get(projectId);
    if (runtime) {
      // Stop old runtime and start new one with updated project
      await runtime.stop();
      const newRuntime = new ProjectRuntime(project);
      await newRuntime.start();
      this.activeRuntimes.set(projectId, newRuntime);
    }

    // Update subscription manager with new agent pubkeys if any
    const agentTags = project.tags.filter((t) => t[0] === "A" && t[1]?.startsWith("31990:"));
    const agentPubkeys: Hexpubkey[] = [];
    for (const tag of agentTags) {
      const pubkey = tag[1]?.split(":")[1];
      if (pubkey) {
        agentPubkeys.push(pubkey as Hexpubkey);
      }
    }

    if (this.subscriptionManager && agentPubkeys.length > 0) {
      // Get all agent pubkeys from all projects
      const allAgentPubkeys = new Set<Hexpubkey>();
      for (const p of this.knownProjects.values()) {
        const tags = p.tags.filter((t) => t[0] === "A" && t[1]?.startsWith("31990:"));
        for (const tag of tags) {
          const pk = tag[1]?.split(":")[1];
          if (pk) {
            allAgentPubkeys.add(pk as Hexpubkey);
          }
        }
      }
      this.subscriptionManager.updateAgentPubkeys(Array.from(allAgentPubkeys));
    }
  }

  /**
   * Determine which project an event should be routed to
   */
  private async determineTargetProject(event: NDKEvent): Promise<string | null> {
    // Check for explicit project A-tags
    const aTags = event.tags.filter(t => t[0] === "A" || t[0] === "a");
    for (const tag of aTags) {
      const aTagValue = tag[1];
      if (aTagValue?.startsWith("31933:")) {
        if (this.knownProjects.has(aTagValue)) {
          return aTagValue;
        }
      }
    }

    // Check for agent P-tags (find project by agent)
    const pTags = event.tags.filter(t => t[0] === "p");
    for (const tag of pTags) {
      const pubkey = tag[1] as Hexpubkey;

      // Search through known projects for this agent
      for (const [projectId, project] of this.knownProjects) {
        const agentTags = project.tags.filter((t) => t[0] === "A" && t[1]?.startsWith("31990:"));
        for (const agentTag of agentTags) {
          const agentPubkey = agentTag[1]?.split(":")[1];
          if (agentPubkey === pubkey) {
            return projectId;
          }
        }
      }
    }

    return null;
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
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
    memory: NodeJS.MemoryUsage;
    uptime: number;
  } {
    // Count total agents across all known projects
    let totalAgents = 0;
    for (const project of this.knownProjects.values()) {
      const agentTags = project.tags.filter((t) => t[0] === "A" && t[1]?.startsWith("31990:"));
      totalAgents += agentTags.length;
    }

    return {
      running: this.isRunning,
      knownProjects: this.knownProjects.size,
      activeProjects: this.activeRuntimes.size,
      agents: totalAgents,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
    };
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