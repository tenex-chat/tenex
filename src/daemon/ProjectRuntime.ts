import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKProject } from "@nostr-dev-kit/ndk";
import { ProjectContext } from "@/services/ProjectContext";
import { projectContextStore } from "@/services/ProjectContextStore";
import { EventHandler } from "@/event-handler";
import { StatusPublisher } from "@/services/status/StatusPublisher";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { LLMLogger } from "@/logging/LLMLogger";
import { ConversationCoordinator } from "@/conversations";
import { logger } from "@/utils/logger";
import { cloneGitRepository, initializeGitRepository } from "@/utils/git";
import { trace } from "@opentelemetry/api";
import * as path from "node:path";
import * as fs from "node:fs/promises";

/**
 * Self-contained runtime for a single project.
 * Manages its own lifecycle, status publishing, and event handling.
 */
export class ProjectRuntime {
  public readonly projectId: string;
  public readonly projectPath: string; // User's git repo path
  private readonly metadataPath: string; // TENEX metadata path
  private readonly dTag: string;

  private project: NDKProject;
  private context: ProjectContext | null = null;
  private eventHandler: EventHandler | null = null;
  private statusPublisher: StatusPublisher | null = null;
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

    // User's git repository: {projectsBase}/{dTag}
    this.projectPath = path.join(projectsBase, dTag);

    // TENEX metadata (hidden): ~/.tenex/projects/{dTag}
    this.metadataPath = path.join(path.dirname(projectsBase), ".tenex", "projects", dTag);
  }

  /**
   * Start the project runtime
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn(`Project runtime already running: ${this.projectId}`);
      return;
    }

    logger.info(`Starting project runtime: ${this.projectId}`, {
      title: this.project.tagValue("title"),
    });

    try {
      // Create TENEX metadata directories: ~/.tenex/projects/<dTag>/{conversations,logs}
      await fs.mkdir(path.join(this.metadataPath, "conversations"), { recursive: true });
      await fs.mkdir(path.join(this.metadataPath, "logs"), { recursive: true });

      // Clone git repository to user-facing location: ~/tenex/<dTag>/
      const repoUrl = this.project.repo;
      if (repoUrl) {
        logger.info(`Project has repository: ${repoUrl}`, { projectId: this.projectId });
        await cloneGitRepository(repoUrl, this.projectPath);
      } else {
        logger.info(`Initializing new git repository`, { projectId: this.projectId });
        await initializeGitRepository(this.projectPath);
      }

      // Initialize components
      const agentRegistry = new AgentRegistry(this.projectPath, this.metadataPath);
      await agentRegistry.loadFromProject(this.project);

      const llmLogger = new LLMLogger();
      llmLogger.initialize(this.metadataPath);

      // Create project context directly (don't use global singleton)
      this.context = new ProjectContext(this.project, agentRegistry, llmLogger);
      await agentRegistry.persistPMStatus();

      // Initialize conversation coordinator with metadata path
      this.conversationCoordinator = new ConversationCoordinator(this.metadataPath);
      await this.conversationCoordinator.initialize();

      // Set conversation coordinator in context
      this.context.conversationCoordinator = this.conversationCoordinator;

      // Initialize event handler with the conversation coordinator
      this.eventHandler = new EventHandler(
        this.projectPath,              // Git repo path for code execution
        this.conversationCoordinator   // Shared conversation coordinator
      );
      await this.eventHandler.initialize();

      // Start status publisher
      this.statusPublisher = new StatusPublisher();
      await projectContextStore.run(this.context, async () => {
        await this.statusPublisher!.startPublishing(this.projectPath, this.context);
      });

      this.isRunning = true;
      this.startTime = new Date();

      logger.info(`Project runtime started successfully: ${this.projectId}`, {
        agentCount: this.context.agents.size,
        pmPubkey: this.context.projectManager?.pubkey?.slice(0, 8),
      });
    } catch (error) {
      logger.error(`Failed to start project runtime: ${this.projectId}`, {
        error: error instanceof Error ? error.message : String(error),
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

    logger.info(`Stopping project runtime: ${this.projectId}`, {
      uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
      eventsProcessed: this.eventCount,
    });

    // Stop status publisher
    if (this.statusPublisher) {
      await this.statusPublisher.stopPublishing();
      this.statusPublisher = null;
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

    // Clear context
    this.context = null;

    this.isRunning = false;

    logger.info(`Project runtime stopped: ${this.projectId}`);
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
}