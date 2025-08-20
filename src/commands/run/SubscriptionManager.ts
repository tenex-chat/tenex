import {
  filterAndRelaySetFromBech32,
  type NDKEvent,
  type NDKFilter,
  type NDKSubscription,
} from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import {
  addProcessedEvent,
  clearProcessedEvents,
  flushProcessedEvents,
  hasProcessedEvent,
  loadProcessedEvents,
} from "@/commands/run/processedEventTracking";
import type { EventHandler } from "@/event-handler";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";

export class SubscriptionManager {
  private subscriptions: NDKSubscription[] = [];
  private eventHandler: EventHandler;
  private projectPath: string;

  constructor(eventHandler: EventHandler, projectPath: string) {
    this.eventHandler = eventHandler;
    this.projectPath = projectPath;
  }

  async start(): Promise<void> {
    // Load previously processed event IDs from disk
    await loadProcessedEvents(this.projectPath);

    // 1. Subscribe to project updates (NDKProject events)
    await this.subscribeToProjectUpdates();

    // 2. Subscribe to agent lessons
    await this.subscribeToAgentLessons();

    // 3. Subscribe to all project-related events
    await this.subscribeToProjectEvents();

    // 4. Subscribe to spec replies (kind 1111 with #K:30023)
    await this.subscribeToSpecReplies();
  }

  private async subscribeToProjectUpdates(): Promise<void> {
    const ndk = getNDK();
    const projectCtx = getProjectContext();
    const project = projectCtx.project;
    const { filter: projectFilter } = filterAndRelaySetFromBech32(project.encode(), ndk);

    // Get all agent pubkeys
    const agentPubkeys = Array.from(projectCtx.agents.values()).map((agent) => agent.pubkey);

    logger.debug("Project update filter:", projectFilter);

    // Create filters array
    const filters: NDKFilter[] = [projectFilter];

    // Add filter for agent pubkeys if any exist
    if (agentPubkeys.length > 0) {
      filters.push({ "#p": agentPubkeys, limit: 1 });
      logger.debug(`Added #p filter for ${agentPubkeys.length} agent pubkeys`);
    }

    const projectSubscription = ndk.subscribe(filters, {
      closeOnEose: false,
      groupable: false,
    });

    projectSubscription.on("event", (event: NDKEvent) => {
      this.handleIncomingEvent(event, "project update");
    });

    this.subscriptions.push(projectSubscription);
  }

  private async subscribeToAgentLessons(): Promise<void> {
    const ndk = getNDK();
    const projectCtx = getProjectContext();

    // Get all agent pubkeys
    const agentPubkeys = Array.from(projectCtx.agents.values()).map((agent) => agent.pubkey);

    if (agentPubkeys.length === 0) {
      logger.warn("⚠️ No agent pubkeys found for lesson subscription");
      return;
    }

    // Create filter for agent lessons
    const lessonFilter: NDKFilter = {
      kinds: NDKAgentLesson.kinds,
      authors: agentPubkeys,
    };

    const lessonSubscription = ndk.subscribe(
      lessonFilter,
      {
        closeOnEose: false,
        groupable: false,
      },
      {
        onEvent: (event: NDKEvent) => {
          try {
            const lesson = NDKAgentLesson.from(event);
            projectCtx.addLesson(lesson.pubkey, lesson);
          } catch (error) {
            logger.error("❌ Error processing agent lesson:", error);
          }
        },
      }
    );

    // Log initial load completion
    lessonSubscription.on("eose", () => {
      const totalLessons = projectCtx.getAllLessons().length;
      logger.info(
        chalk.green(
          `    ✓ Agent lessons subscription active - loaded ${totalLessons} historical lessons`
        )
      );

      // Log lesson distribution
      const distribution = new Map<string, number>();
      for (const [pubkey, lessons] of projectCtx.agentLessons) {
        const agent = Array.from(projectCtx.agents.values()).find((a) => a.pubkey === pubkey);
        const name = agent?.name || "Unknown";
        distribution.set(name, lessons.length);
      }
    });

    this.subscriptions.push(lessonSubscription);
  }

  private async subscribeToProjectEvents(): Promise<void> {
    // Filter for all events that tag this project
    const projectCtx = getProjectContext();
    const project = projectCtx.project;
    const projectTagFilter: NDKFilter = {
      ...project.filter(),
      limit: 1,
    };

    logger.debug("Project event filter:", projectTagFilter);

    const ndk = getNDK();
    const projectEventSubscription = ndk.subscribe(
      projectTagFilter,
      {
        closeOnEose: false,
        groupable: false,
      },
      {
        onEvent: (event: NDKEvent) => {
          this.handleIncomingEvent(event, "project event");
        },
      }
    );

    this.subscriptions.push(projectEventSubscription);
  }

  private async subscribeToSpecReplies(): Promise<void> {
    const ndk = getNDK();

    // Subscribe to spec replies (kind 1111 with #K:30023)
    const specReplyFilter: NDKFilter = {
      kinds: [1111],
      "#K": ["30023"],
    };

    logger.info(chalk.blue("  • Setting up spec reply subscription..."));
    logger.debug("Spec reply filter:", specReplyFilter);

    const specReplySubscription = ndk.subscribe(
      specReplyFilter,
      {
        closeOnEose: false,
        groupable: false,
      },
      {
        onEvent: (event: NDKEvent) => {
          // Use the A tag value as conversationId for routing
          const conversationId = event.tagValue("A");
          if (conversationId) {
            // Route as a normal conversation event
            this.handleIncomingEvent(event, "spec reply");
          } else {
            logger.warn("Spec reply event missing A tag:", event.id);
          }
        },
      }
    );

    this.subscriptions.push(specReplySubscription);
  }

  private async handleIncomingEvent(event: NDKEvent, source: string): Promise<void> {
    // Check for duplicate events
    if (hasProcessedEvent(event.id)) {
      return;
    }

    // Mark as processed
    addProcessedEvent(this.projectPath, event.id);

    // Log receipt
    try {
      await this.eventHandler.handleEvent(event);
    } catch (error) {
      logger.error(`Error handling event from ${source}:`, error);
    }
  }

  async stop(): Promise<void> {
    for (const subscription of this.subscriptions) {
      subscription.stop();
    }

    this.subscriptions = [];

    // Flush any pending saves to disk before stopping
    await flushProcessedEvents(this.projectPath);
    clearProcessedEvents();
  }
}
