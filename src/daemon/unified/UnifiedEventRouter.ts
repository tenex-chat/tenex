import type { NDKEvent, Hexpubkey } from "@nostr-dev-kit/ndk";
import { NDKProject } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import { getProjectContextManager, type ProjectContextManager } from "./ProjectContextManager";
import { EventHandler } from "@/event-handler";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { LLMLogger } from "@/logging/LLMLogger";
import { getNDK } from "@/nostr/ndkClient";
import { ConversationCoordinator } from "@/conversations";
import * as path from "node:path";
import * as fs from "node:fs/promises";

/**
 * Routes events to the appropriate project context in the unified daemon.
 * Handles project discovery, initialization, and event dispatch.
 */
export class UnifiedEventRouter {
  private projectManager: ProjectContextManager;

  /**
   * Map of project ID to EventHandler for that project
   */
  private eventHandlers = new Map<string, EventHandler>();

  /**
   * Track processed events per project to prevent duplicates
   * Key: projectId, Value: Set of event IDs
   */
  private processedEvents = new Map<string, Set<string>>();

  /**
   * Cache of project ID lookups for events
   * Key: event ID, Value: project ID
   */
  private eventProjectCache = new Map<string, string>();

  constructor() {
    this.projectManager = getProjectContextManager();
  }

  /**
   * Route an event to the appropriate project
   */
  async routeEvent(event: NDKEvent): Promise<void> {
    try {
      // 1. Special handling for project events (kind 31933)
      if (event.kind === 31933) {
        await this.handleProjectEvent(event);
        return;
      }

      // 2. Determine target project(s)
      const projectIds = await this.determineTargetProjects(event);

      if (projectIds.length === 0) {
        logger.debug("Event has no target projects, ignoring", {
          eventId: event.id.slice(0, 8),
          kind: event.kind,
        });
        return;
      }

      // 3. Route to each target project
      for (const projectId of projectIds) {
        await this.routeToProject(projectId, event);
      }
    } catch (error) {
      logger.error("Error routing event", {
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

    logger.info("Processing project event", {
      projectId,
      title: event.tags.find(t => t[0] === "title")?.[1],
      isUpdate: this.projectManager.hasProject(projectId),
    });

    // Convert NDKEvent to NDKProject
    const project = new NDKProject(getNDK(), event.rawEvent());

    if (this.projectManager.hasProject(projectId)) {
      // Update existing project
      await this.projectManager.updateProject(project);
    } else {
      // New project - initialize it
      await this.initializeProject(project);
    }

    // Also route this event to the project for processing
    await this.routeToProject(projectId, event);
  }

  /**
   * Initialize a new project
   */
  private async initializeProject(project: NDKProject): Promise<void> {
    const projectId = this.buildProjectId(project);

    logger.info("Initializing new project", {
      projectId,
      title: project.tagValue("title"),
    });

    try {
      // Create project-specific directories
      const projectDir = `.tenex/projects/${projectId}`;
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(path.join(projectDir, "conversations"), { recursive: true });
      await fs.mkdir(path.join(projectDir, "logs"), { recursive: true });

      // Create AgentRegistry for this project
      const agentRegistry = new AgentRegistry();
      await agentRegistry.loadFromProject(project);

      // Create LLMLogger for this project
      const llmLogger = new LLMLogger(path.join(projectDir, "logs", "llm.log"));

      // Load the project into context manager
      const context = await this.projectManager.loadProject(
        project,
        agentRegistry,
        llmLogger
      );

      // Create EventHandler for this project
      const eventHandler = new EventHandler(projectDir);
      await eventHandler.initialize();
      this.eventHandlers.set(projectId, eventHandler);

      // Initialize conversation coordinator
      context.conversationCoordinator = new ConversationCoordinator(
        path.join(projectDir, "conversations")
      );

      // Initialize processed events tracking
      this.processedEvents.set(projectId, new Set());

      // Load previously processed events if they exist
      await this.loadProcessedEvents(projectId);

      logger.info("Project initialized successfully", {
        projectId,
        agentCount: context.agents.size,
        pmPubkey: context.projectManager?.pubkey?.slice(0, 8),
      });
    } catch (error) {
      logger.error("Failed to initialize project", {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Determine which project(s) an event should be routed to
   */
  private async determineTargetProjects(event: NDKEvent): Promise<string[]> {
    const projects = new Set<string>();

    // Check cache first
    const cachedProject = this.eventProjectCache.get(event.id);
    if (cachedProject) {
      return [cachedProject];
    }

    // 1. Check for explicit project A-tags
    const aTags = event.tags.filter(t => t[0] === "A" || t[0] === "a");
    for (const tag of aTags) {
      const aTagValue = tag[1];
      if (aTagValue?.startsWith("31933:")) {
        projects.add(aTagValue);
      }
    }

    // If we found explicit project tags, use those
    if (projects.size > 0) {
      const projectList = Array.from(projects);
      // Cache for future lookups
      if (projectList.length === 1) {
        this.eventProjectCache.set(event.id, projectList[0]);
      }
      return projectList;
    }

    // 2. Check for agent P-tags (find project by agent)
    const pTags = event.tags.filter(t => t[0] === "p");
    for (const tag of pTags) {
      const pubkey = tag[1] as Hexpubkey;
      const projectIds = this.projectManager.findProjectsForAgent(pubkey);

      if (projectIds.length > 0) {
        // Use first matching project
        projects.add(projectIds[0]);
        break; // Only route to one project when using p-tag routing
      }
    }

    // 3. Check if it's a reply to an event we've processed
    const eTags = event.tags.filter(t => t[0] === "e");
    for (const tag of eTags) {
      const referencedEventId = tag[1];
      const projectId = this.eventProjectCache.get(referencedEventId);
      if (projectId) {
        projects.add(projectId);
        break; // Only route to one project for replies
      }
    }

    const projectList = Array.from(projects);

    // Cache for future lookups if single project
    if (projectList.length === 1) {
      this.eventProjectCache.set(event.id, projectList[0]);
    }

    return projectList;
  }

  /**
   * Route an event to a specific project
   */
  private async routeToProject(projectId: string, event: NDKEvent): Promise<void> {
    // Check if already processed
    if (this.isProcessed(projectId, event.id)) {
      logger.debug("Event already processed for project", {
        projectId: projectId.slice(0, 20),
        eventId: event.id.slice(0, 8),
      });
      return;
    }

    // Get or initialize project context
    let context = this.projectManager.getContext(projectId);
    if (!context) {
      logger.warn("Project not loaded, attempting to fetch", {
        projectId,
      });

      // Try to fetch the project from Nostr
      const ndk = getNDK();
      const projectEvent = await ndk.fetchEvent({
        kinds: [31933],
        "#d": [projectId.split(":")[2]],
        authors: [projectId.split(":")[1] as Hexpubkey],
      });

      if (!projectEvent) {
        logger.error("Could not find project event", { projectId });
        return;
      }

      const project = new NDKProject(ndk, projectEvent.rawEvent());
      await this.initializeProject(project);
      context = this.projectManager.getContext(projectId);

      if (!context) {
        logger.error("Failed to initialize project context", { projectId });
        return;
      }
    }

    // Switch to this project's context
    this.projectManager.switchContext(projectId);

    // Get or create event handler for this project
    let eventHandler = this.eventHandlers.get(projectId);
    if (!eventHandler) {
      const projectDir = `.tenex/projects/${projectId}`;
      eventHandler = new EventHandler(projectDir);
      await eventHandler.initialize();
      this.eventHandlers.set(projectId, eventHandler);
    }

    logger.debug("Routing event to project", {
      projectId: projectId.slice(0, 20),
      eventId: event.id.slice(0, 8),
      eventKind: event.kind,
    });

    // Handle the event
    await eventHandler.handleEvent(event);

    // Mark as processed
    await this.markProcessed(projectId, event.id);
  }

  /**
   * Check if an event has been processed for a project
   */
  private isProcessed(projectId: string, eventId: string): boolean {
    const processed = this.processedEvents.get(projectId);
    return processed ? processed.has(eventId) : false;
  }

  /**
   * Mark an event as processed for a project
   */
  private async markProcessed(projectId: string, eventId: string): Promise<void> {
    let processed = this.processedEvents.get(projectId);
    if (!processed) {
      processed = new Set();
      this.processedEvents.set(projectId, processed);
    }

    processed.add(eventId);

    // Persist to disk (debounced)
    await this.persistProcessedEvents(projectId);
  }

  /**
   * Load processed events from disk
   */
  private async loadProcessedEvents(projectId: string): Promise<void> {
    const filePath = `.tenex/projects/${projectId}/processed-events.json`;

    try {
      const data = await fs.readFile(filePath, "utf-8");
      const eventIds = JSON.parse(data) as string[];
      this.processedEvents.set(projectId, new Set(eventIds));

      logger.debug("Loaded processed events", {
        projectId: projectId.slice(0, 20),
        count: eventIds.length,
      });
    } catch (error) {
      // File doesn't exist yet, that's ok
      if ((error as any).code !== "ENOENT") {
        logger.error("Failed to load processed events", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Persist processed events to disk (debounced per project)
   */
  private persistTimers = new Map<string, NodeJS.Timeout>();

  private async persistProcessedEvents(projectId: string): Promise<void> {
    // Clear existing timer
    const existingTimer = this.persistTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer (5 second debounce)
    const timer = setTimeout(async () => {
      const processed = this.processedEvents.get(projectId);
      if (!processed) return;

      const filePath = `.tenex/projects/${projectId}/processed-events.json`;

      try {
        // Keep only last 10,000 events to prevent unbounded growth
        const eventIds = Array.from(processed).slice(-10000);
        await fs.writeFile(filePath, JSON.stringify(eventIds, null, 2));

        logger.debug("Persisted processed events", {
          projectId: projectId.slice(0, 20),
          count: eventIds.length,
        });
      } catch (error) {
        logger.error("Failed to persist processed events", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      this.persistTimers.delete(projectId);
    }, 5000);

    this.persistTimers.set(projectId, timer);
  }

  /**
   * Build project ID from event
   */
  private buildProjectId(event: NDKEvent | NDKProject): string {
    const dTag = event.tags.find(t => t[0] === "d")?.[1];
    if (!dTag) {
      throw new Error("Project event missing d tag");
    }
    return `31933:${event.pubkey}:${dTag}`;
  }

  /**
   * Clean up resources
   */
  async shutdown(): Promise<void> {
    // Clear all timers
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }

    // Persist all pending data
    for (const projectId of this.processedEvents.keys()) {
      const processed = this.processedEvents.get(projectId);
      if (processed && processed.size > 0) {
        const filePath = `.tenex/projects/${projectId}/processed-events.json`;
        const eventIds = Array.from(processed).slice(-10000);
        await fs.writeFile(filePath, JSON.stringify(eventIds, null, 2));
      }
    }

    logger.info("Unified event router shut down");
  }

  /**
   * Get router statistics
   */
  getStats(): {
    loadedProjects: number;
    eventHandlers: number;
    processedEventsTotal: number;
    cacheSize: number;
  } {
    let processedTotal = 0;
    for (const processed of this.processedEvents.values()) {
      processedTotal += processed.size;
    }

    return {
      loadedProjects: this.projectManager.getProjectIds().length,
      eventHandlers: this.eventHandlers.size,
      processedEventsTotal: processedTotal,
      cacheSize: this.eventProjectCache.size,
    };
  }
}