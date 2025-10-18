import type { NDKEvent, NDKFilter, NDKSubscription, Hexpubkey } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import type { EventRoutingLogger } from "@/logging/EventRoutingLogger";

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
    logger.info("Starting subscription manager", {
      whitelistedPubkeys: Array.from(this.whitelistedPubkeys).map(p => p.slice(0, 8)),
      knownProjects: this.knownProjects.size,
      agentPubkeys: this.agentPubkeys.size,
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

    logger.info("Creating subscription with filters", {
      filterCount: filters.length,
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

    // Filter 1: Everything from whitelisted pubkeys
    // This catches new projects, agents, and all their activities
    if (this.whitelistedPubkeys.size > 0) {
      filters.push({
        authors: Array.from(this.whitelistedPubkeys),
        limit: 0, // No historical data
      });
    }

    // Filter 2: Events tagging our known projects
    // This catches external interactions with our projects
    if (this.knownProjects.size > 0) {
      filters.push({
        "#A": Array.from(this.knownProjects),
        limit: 0,
      });
    }

    // Filter 3: Events mentioning our agents
    // This catches direct mentions of agents even without project tags
    if (this.agentPubkeys.size > 0) {
      filters.push({
        "#p": Array.from(this.agentPubkeys),
        limit: 0,
      });
    }

    // If no filters, create a minimal filter to keep connection alive
    if (filters.length === 0) {
      logger.warn("No active filters, creating minimal subscription");
      filters.push({
        authors: Array.from(this.whitelistedPubkeys),
        kinds: [31933], // At least listen for project events
        limit: 0,
      });
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
   */
  private async checkForSubscriptionUpdates(event: NDKEvent): Promise<void> {
    let needsRestart = false;

    // New project event (kind 31933)
    if (event.kind === 31933) {
      const projectId = this.buildProjectId(event);
      if (!this.knownProjects.has(projectId)) {
        logger.info(`New project discovered: ${projectId}`);
        this.knownProjects.add(projectId);
        needsRestart = true;
      }
    }

    // New agent event (kind 32033)
    if (event.kind === 32033) {
      const agentPubkey = event.tags.find(t => t[0] === "d")?.[1];
      if (agentPubkey && !this.agentPubkeys.has(agentPubkey as Hexpubkey)) {
        logger.info(`New agent discovered: ${agentPubkey.slice(0, 8)}`);
        this.agentPubkeys.add(agentPubkey as Hexpubkey);
        needsRestart = true;
      }
    }

    // Agent update that might add/remove agents from projects
    if (event.kind === 31933) {
      // Project update might have new agents
      await this.updateAgentListFromProject(event);
    }

    if (needsRestart) {
      this.scheduleRestart();
    }
  }

  /**
   * Update agent list from a project event
   */
  private async updateAgentListFromProject(projectEvent: NDKEvent): Promise<void> {
    const agentTags = projectEvent.tags.filter(t => t[0] === "agent");
    let newAgentsFound = false;

    for (const tag of agentTags) {
      const agentEventId = tag[1];
      if (!agentEventId) continue;

      // Extract pubkey from the event ID (format: "32033:pubkey:...")
      const parts = agentEventId.split(":");
      if (parts.length >= 2 && parts[0] === "32033") {
        const agentPubkey = parts[1] as Hexpubkey;
        if (!this.agentPubkeys.has(agentPubkey)) {
          logger.info(`New agent found in project: ${agentPubkey.slice(0, 8)}`);
          this.agentPubkeys.add(agentPubkey);
          newAgentsFound = true;
        }
      }
    }

    if (newAgentsFound) {
      this.scheduleRestart();
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
      logger.info("Restarting subscription with updated filters");
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
      logger.info("Known projects updated", {
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
      logger.info("Agent pubkeys updated", {
        old: oldSize,
        new: this.agentPubkeys.size,
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

    logger.info("Subscription stopped");
  }

  /**
   * Get current subscription status
   */
  getStatus(): {
    active: boolean;
    whitelistedPubkeys: number;
    knownProjects: number;
    agentPubkeys: number;
    restartPending: boolean;
  } {
    return {
      active: this.subscription !== null,
      whitelistedPubkeys: this.whitelistedPubkeys.size,
      knownProjects: this.knownProjects.size,
      agentPubkeys: this.agentPubkeys.size,
      restartPending: this.restartPending,
    };
  }
}