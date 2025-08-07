import {
    addProcessedEvent,
    clearProcessedEvents,
    flushProcessedEvents,
    hasProcessedEvent,
    loadProcessedEvents,
} from "@/commands/run/processedEventTracking";
import type { EventHandler } from "@/event-handler";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { EVENT_KINDS } from "@/llm/types";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";
import {
    type NDKEvent,
    type NDKFilter,
    type NDKSubscription,
    filterAndRelaySetFromBech32,
} from "@nostr-dev-kit/ndk";
import chalk from "chalk";

export class SubscriptionManager {
    private subscriptions: NDKSubscription[] = [];
    private eventHandler: EventHandler;
    private projectPath: string;

    constructor(eventHandler: EventHandler, projectPath: string) {
        this.eventHandler = eventHandler;
        this.projectPath = projectPath;
    }

    async start(): Promise<void> {
        logger.info(chalk.cyan("📡 Setting up project subscriptions..."));

        // Load previously processed event IDs from disk
        await loadProcessedEvents(this.projectPath);

        // 1. Subscribe to project updates (NDKProject events)
        await this.subscribeToProjectUpdates();

        // 2. Subscribe to agent lessons
        await this.subscribeToAgentLessons();

        // 3. Subscribe to all project-related events
        await this.subscribeToProjectEvents();
    }

    private async subscribeToProjectUpdates(): Promise<void> {
        const ndk = getNDK();
        const projectCtx = getProjectContext();
        const project = projectCtx.project;
        const { filter: projectFilter } = filterAndRelaySetFromBech32(project.encode(), ndk);

        logger.info(chalk.blue("  • Setting up project update subscription..."));
        logger.debug("Project update filter:", projectFilter);

        const projectSubscription = ndk.subscribe(projectFilter, {
            closeOnEose: false,
            groupable: false,
        });

        projectSubscription.on("event", (event: NDKEvent) => {
            this.handleIncomingEvent(event, "project update");
        });

        this.subscriptions.push(projectSubscription);
        logger.info(chalk.green("    ✓ Project update subscription active"));
    }

    private async subscribeToAgentLessons(): Promise<void> {
        const ndk = getNDK();
        const projectCtx = getProjectContext();
        const project = projectCtx.project;

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
        
        logger.info("📚 Setting up agent lessons subscription", {
            projectId: project.id,
            projectTagId: project.tagId(),
            agentCount: agentPubkeys.length,
            kinds: NDKAgentLesson.kinds,
            filter: lessonFilter,
        });

        const lessonSubscription = ndk.subscribe(lessonFilter, {
            closeOnEose: false,
            groupable: false,
        });

        lessonSubscription.on("event", (event: NDKEvent) => {
            try {
                // Convert to NDKAgentLesson
                const lesson = NDKAgentLesson.from(event);
                
                logger.info("📖 Received agent lesson event", {
                    lessonId: lesson.id,
                    lessonTitle: lesson.title,
                    authorPubkey: lesson.pubkey,
                    projectTag: lesson.tags.find(t => t[0] === "a")?.[1],
                    createdAt: lesson.created_at,
                });

                // Add to project context
                projectCtx.addLesson(lesson.pubkey, lesson);
                logger.debug("✅ Lesson added to project context", {
                    agentPubkey: lesson.pubkey,
                    currentLessonCount: projectCtx.getLessonsForAgent(lesson.pubkey).length,
                });
            } catch (error) {
                logger.error("❌ Error processing agent lesson:", error);
            }
        });

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
                const agent = Array.from(projectCtx.agents.values()).find(
                    (a) => a.pubkey === pubkey
                );
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

        logger.info(chalk.blue("  • Setting up project event subscription..."));
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
        logger.info(chalk.green("    ✓ Project event subscription active"));
    }

    private async handleIncomingEvent(event: NDKEvent, source: string): Promise<void> {
        // Check for duplicate events
        if (hasProcessedEvent(event.id)) {
            logger.debug(`Skipping duplicate event ${event.id} from ${source}`);
            return;
        }

        // Mark as processed
        addProcessedEvent(this.projectPath, event.id);

        // Log receipt
        if (event.kind !== EVENT_KINDS.PROJECT_STATUS) {
            try {
                await this.eventHandler.handleEvent(event);
            } catch (error) {
                logger.error(`Error handling event from ${source}:`, error);
            }
        }
    }

    async stop(): Promise<void> {
        logger.info("Stopping subscriptions...");

        for (const subscription of this.subscriptions) {
            subscription.stop();
        }

        this.subscriptions = [];

        // Flush any pending saves to disk before stopping
        await flushProcessedEvents(this.projectPath);
        clearProcessedEvents();

        logger.info("All subscriptions stopped");
    }
}
