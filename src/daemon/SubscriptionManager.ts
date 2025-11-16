import type { NDKEvent, NDKFilter, NDKSubscription, Hexpubkey } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import type { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import { NDKKind } from "@/nostr/kinds";

/**
 * Manages a single subscription for all projects and agents.
 */
export class SubscriptionManager {
  private ndk: NDK;
  private subscription: NDKSubscription | null = null;
  private eventHandler: (event: NDKEvent) => Promise<void>;
  private routingLogger: EventRoutingLogger;

  /**
   * Whitelisted pubkeys that can create/manage projects
   */
  private whitelistedPubkeys: Set<Hexpubkey>;

  /**
   * Known project A-tags we're monitoring
   * Format: "31933:authorPubkey:dTag"
   */
  private knownProjects: Set<string> = new Set();

  /**
   * Agent pubkeys we're monitoring across all projects
   */
  private agentPubkeys: Set<Hexpubkey> = new Set();

  /**
   * Agent definition event IDs we're monitoring for lessons
   * Format: event ID of the NDKAgentDefinition (kind 4199)
   */
  private agentDefinitionIds: Set<string> = new Set();

  /**
   * Track if we need to restart the subscription
   */
  private restartPending = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    ndk: NDK,
    eventHandler: (event: NDKEvent) => Promise<void>,
    whitelistedPubkeys: Hexpubkey[],
    routingLogger: EventRoutingLogger
  ) {
    this.ndk = ndk;
    this.eventHandler = eventHandler;
    this.whitelistedPubkeys = new Set(whitelistedPubkeys);
    this.routingLogger = routingLogger;
  }

  /**
   * Start the subscription
   */
  async start(): Promise<void> {
    logger.debug("Starting subscription manager", {
      whitelistedPubkeys: Array.from(this.whitelistedPubkeys).map(p => p.slice(0, 8)),
      knownProjects: this.knownProjects.size,
      agentPubkeys: this.agentPubkeys.size,
      agentDefinitionIds: this.agentDefinitionIds.size,
    });

    await this.createSubscription();
  }

  /**
   * Create or recreate the NDK subscription
   */
  private async createSubscription(): Promise<void> {
    // Stop existing subscription if any
    if (this.subscription) {
      this.subscription.stop();
      this.subscription = null;
    }

    const filters = this.buildFilters();

    logger.debug("Creating subscription with filters", {
      filterCount: filters.length,
      whitelistedAuthors: this.whitelistedPubkeys.size,
      trackedProjects: this.knownProjects.size,
      trackedAgents: this.agentPubkeys.size,
      trackedDefinitions: this.agentDefinitionIds.size,
    });

    // Log the actual filters being used
    await this.routingLogger.logSubscriptionFilters({
      filters,
      whitelistedAuthors: this.whitelistedPubkeys.size,
      trackedProjects: this.knownProjects.size,
      trackedAgents: this.agentPubkeys.size,
    });

    this.subscription = this.ndk.subscribe(filters, {
      closeOnEose: false,
      groupable: true,
    });

    this.subscription.on("event", async (event: NDKEvent) => {
      try {
        await this.handleEvent(event);
      } catch (error) {
        logger.error("Error handling event in subscription", {
          error: error instanceof Error ? error.message : String(error),
          eventId: event.id,
          eventKind: event.kind,
        });
      }
    });

    this.subscription.on("eose", () => {
      logger.debug("Subscription EOSE received");
    });
  }

  /**
   * Build the subscription filters
   */
  private buildFilters(): NDKFilter[] {
    const filters: NDKFilter[] = [];

    // Filter 0: Project events (kind 31933) from whitelisted pubkeys
    // This ensures we receive project creation and update events
    if (this.whitelistedPubkeys.size > 0) {
      filters.push({
        kinds: [31933],
        authors: Array.from(this.whitelistedPubkeys),
      });
    }

    // Filter 1: Events tagging our known projects
    if (this.knownProjects.size > 0) {
      filters.push({
        "#a": Array.from(this.knownProjects),
        limit: 0,
      });
    }

    // Filter 2: Events mentioning our agents
    if (this.agentPubkeys.size > 0) {
      filters.push({
        "#p": Array.from(this.agentPubkeys),
        limit: 0,
      });
    }

    // Filter 3: Agent lessons - monitor both:
    // A. Lessons published by our agents
    // B. Lessons referencing our agent definitions (via e-tag)
    if (this.agentPubkeys.size > 0 || this.agentDefinitionIds.size > 0) {
      // Filter 3a: Lessons published by our agents
      if (this.agentPubkeys.size > 0) {
        filters.push({
          kinds: [NDKKind.AgentLesson],
          authors: Array.from(this.agentPubkeys),
          limit: 0,
        });
      }

      // Filter 3b: Lessons referencing our agent definitions
      if (this.agentDefinitionIds.size > 0) {
        filters.push({
          kinds: [NDKKind.AgentLesson],
          "#e": Array.from(this.agentDefinitionIds),
          limit: 0,
        });
      }
    }

    return filters;
  }

  /**
   * Handle incoming events
   */
  private async handleEvent(event: NDKEvent): Promise<void> {
    logger.debug("Subscription received event", {
      id: event.id,
      kind: event.kind,
      author: event.pubkey,
      tagCount: event.tags.length,
      aTags: event.tags.filter(t => t[0] === "A" || t[0] === "a").map(t => t[1]),
      pTags: event.tags.filter(t => t[0] === "p").map(t => t[1]?.slice(0, 8)),
      eTags: event.tags.filter(t => t[0] === "e").map(t => t[1]?.slice(0, 8)),
      contentLength: event.content?.length || 0,
    });

    // Route the event to the handler
    await this.eventHandler(event);

    // Check if this event requires subscription updates
    await this.checkForSubscriptionUpdates(event);
  }

  /**
   * Check if an event requires updating our subscription
   * Note: Project events (kind 31933) are handled by Daemon.handleProjectEvent
   * which calls updateKnownProjects() to update the subscription.
   * This method is kept for potential future use with other event types.
   */
  private async checkForSubscriptionUpdates(_event: NDKEvent): Promise<void> {
    // Project discovery is now handled by Daemon.handleProjectEvent
    // which will call updateKnownProjects() when new projects are discovered
  }

  /**
   * Schedule a subscription restart (debounced to avoid rapid restarts)
   */
  private scheduleRestart(): void {
    if (this.restartPending) return;

    this.restartPending = true;

    // Clear existing timer
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }

    // Restart after 2 seconds to batch multiple updates
    this.restartTimer = setTimeout(async () => {
      logger.debug("Restarting subscription with updated filters");
      this.restartPending = false;
      this.restartTimer = null;
      await this.createSubscription();
    }, 2000);
  }

  /**
   * Manually update known projects (called by ProjectContextManager)
   */
  updateKnownProjects(projectIds: string[]): void {
    const oldSize = this.knownProjects.size;
    this.knownProjects = new Set(projectIds);

    if (oldSize !== this.knownProjects.size) {
      logger.debug("Known projects updated", {
        old: oldSize,
        new: this.knownProjects.size,
      });
      this.scheduleRestart();
    }
  }

  /**
   * Manually update agent pubkeys (called by ProjectContextManager)
   */
  updateAgentPubkeys(pubkeys: Hexpubkey[]): void {
    const oldSize = this.agentPubkeys.size;
    this.agentPubkeys = new Set(pubkeys);

    if (oldSize !== this.agentPubkeys.size) {
      logger.debug("Agent pubkeys updated", {
        old: oldSize,
        new: this.agentPubkeys.size,
      });
      this.scheduleRestart();
    }
  }

  /**
   * Manually update agent definition IDs (called by ProjectContextManager)
   */
  updateAgentDefinitionIds(eventIds: string[]): void {
    const oldSize = this.agentDefinitionIds.size;
    this.agentDefinitionIds = new Set(eventIds);

    if (oldSize !== this.agentDefinitionIds.size) {
      logger.debug("Agent definition IDs updated", {
        old: oldSize,
        new: this.agentDefinitionIds.size,
      });
      this.scheduleRestart();
    }
  }

  /**
   * Stop the subscription
   */
  stop(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.subscription) {
      this.subscription.stop();
      this.subscription = null;
    }

    logger.debug("Subscription stopped");
  }

  /**
   * Get current subscription status
   */
  getStatus(): {
    active: boolean;
    whitelistedPubkeys: number;
    knownProjects: number;
    agentPubkeys: number;
    agentDefinitionIds: number;
    restartPending: boolean;
  } {
    return {
      active: this.subscription !== null,
      whitelistedPubkeys: this.whitelistedPubkeys.size,
      knownProjects: this.knownProjects.size,
      agentPubkeys: this.agentPubkeys.size,
      agentDefinitionIds: this.agentDefinitionIds.size,
      restartPending: this.restartPending,
    };
  }
}