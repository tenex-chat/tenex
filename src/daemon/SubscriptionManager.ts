import type { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import { NDKKind } from "@/nostr/kinds";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent, NDKSubscription } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { SubscriptionFilterBuilder, type SubscriptionConfig } from "./filters/SubscriptionFilterBuilder";
import { trace } from "@opentelemetry/api";

const lessonTracer = trace.getTracer("tenex.lessons");

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
            whitelistedPubkeys: Array.from(this.whitelistedPubkeys).map((p) => p.slice(0, 8)),
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
        const span = lessonTracer.startSpan("tenex.lesson.subscription_create", {
            attributes: {
                "subscription.agent_pubkeys_count": this.agentPubkeys.size,
                "subscription.agent_definition_ids_count": this.agentDefinitionIds.size,
                "subscription.agent_definition_ids": JSON.stringify(
                    Array.from(this.agentDefinitionIds).map((id) => id.substring(0, 16))
                ),
                "subscription.agent_pubkeys": JSON.stringify(
                    Array.from(this.agentPubkeys).map((pk) => pk.substring(0, 16))
                ),
            },
        });

        // Stop existing subscription if any
        if (this.subscription) {
            span.addEvent("stopping_existing_subscription");
            this.subscription.stop();
            this.subscription = null;
        }

        // Build filters using the centralized SubscriptionFilterBuilder
        const config: SubscriptionConfig = {
            whitelistedPubkeys: this.whitelistedPubkeys,
            knownProjects: this.knownProjects,
            agentPubkeys: this.agentPubkeys,
            agentDefinitionIds: this.agentDefinitionIds,
        };
        const filters = SubscriptionFilterBuilder.buildFilters(config);

        // Count lesson-specific filters
        const lessonFilters = filters.filter((f) => f.kinds?.includes(NDKKind.AgentLesson));
        span.setAttribute("subscription.lesson_filters_count", lessonFilters.length);
        span.setAttribute("subscription.total_filters_count", filters.length);

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
            // Note: Can't add to span here - it's already ended by the time eose fires
            logger.debug("Subscription EOSE received", {
                agentDefinitionIdsCount: this.agentDefinitionIds.size,
                agentPubkeysCount: this.agentPubkeys.size,
            });
        });

        span.addEvent("subscription_created", {
            "subscription.filters_count": filters.length,
            "subscription.lesson_filters_count": lessonFilters.length,
        });
        span.end();
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
            aTags: event.tags.filter((t) => t[0] === "a").map((t) => t[1]),
            pTags: event.tags.filter((t) => t[0] === "p").map((t) => t[1]?.slice(0, 8)),
            eTags: event.tags.filter((t) => t[0] === "e").map((t) => t[1]?.slice(0, 8)),
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
     * Manually update known projects (called by Daemon)
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
     * Manually update agent pubkeys (called by Daemon)
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
     * Manually update agent definition IDs (called by Daemon)
     */
    updateAgentDefinitionIds(eventIds: string[]): void {
        const span = lessonTracer.startSpan("tenex.lesson.subscription_update", {
            attributes: {
                "subscription.old_definition_ids_count": this.agentDefinitionIds.size,
                "subscription.new_definition_ids_count": eventIds.length,
                "subscription.old_definition_ids": JSON.stringify(
                    Array.from(this.agentDefinitionIds).map((id) => id.substring(0, 16))
                ),
                "subscription.new_definition_ids": JSON.stringify(
                    eventIds.map((id) => id.substring(0, 16))
                ),
            },
        });

        const oldSize = this.agentDefinitionIds.size;
        const oldIds = new Set(this.agentDefinitionIds);
        this.agentDefinitionIds = new Set(eventIds);

        // Check both size change AND content change
        const sizeChanged = oldSize !== this.agentDefinitionIds.size;
        const contentChanged = !this.setsEqual(oldIds, this.agentDefinitionIds);

        span.setAttribute("subscription.size_changed", sizeChanged);
        span.setAttribute("subscription.content_changed", contentChanged);
        span.setAttribute("subscription.will_restart", sizeChanged || contentChanged);

        if (sizeChanged || contentChanged) {
            logger.debug("Agent definition IDs updated", {
                old: oldSize,
                new: this.agentDefinitionIds.size,
                contentChanged,
            });
            span.addEvent("scheduling_restart", {
                "reason": contentChanged ? "content_changed" : "size_changed",
            });
            this.scheduleRestart();
        }

        span.end();
    }

    /**
     * Helper to compare two sets for equality
     */
    private setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
        if (a.size !== b.size) return false;
        for (const item of a) {
            if (!b.has(item)) return false;
        }
        return true;
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
