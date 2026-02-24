import type { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { SubscriptionFilterBuilder } from "./filters/SubscriptionFilterBuilder";

/**
 * Manages independent subscriptions for different event categories.
 *
 * Instead of a single monolithic subscription that is torn down and recreated
 * whenever any tracked set changes, this manager maintains four independent
 * subscription groups:
 *
 * 1. Static — project discovery, config updates, lesson comments (never recreated)
 * 2. Known-projects — events tagged with project a-tags (recreated on project changes)
 * 3. Agent-mentions — events p-tagging agents (recreated on agent pubkey changes)
 * 4. Per-agent lessons — one per agent definition ID (individually managed)
 */
export class SubscriptionManager {
    private ndk: NDK;
    private eventHandler: (event: NDKEvent) => Promise<void>;
    private routingLogger: EventRoutingLogger;
    private whitelistedPubkeys: Set<Hexpubkey>;

    // Dedup: multiple subscriptions can deliver the same event
    private recentEventIds = new Set<string>();
    private recentEventTimer: NodeJS.Timeout | null = null;

    // Independent subscription groups
    private staticSubscription: NDKSubscription | null = null;
    private projectSubscription: NDKSubscription | null = null;
    private agentMentionsSubscription: NDKSubscription | null = null;
    private lessonSubscriptions = new Map<string, NDKSubscription>();

    // Per-subscription since tracking
    private lastProjectSubCreatedAt: number | null = null;
    private lastAgentMentionsSubCreatedAt: number | null = null;

    // Debounce for agent mentions updates
    private agentMentionsTimer: NodeJS.Timeout | null = null;
    private pendingAgentMentionsPubkeys: Set<Hexpubkey> | null = null;

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
     * Start subscriptions. Creates the static subscription immediately.
     * Project and agent-mentions subscriptions are created later as data arrives.
     */
    async start(): Promise<void> {
        logger.debug("Starting subscription manager", {
            whitelistedPubkeys: Array.from(this.whitelistedPubkeys).map((p) => p.slice(0, 8)),
        });

        const filters = SubscriptionFilterBuilder.buildStaticFilters(this.whitelistedPubkeys);
        if (filters.length > 0) {
            this.staticSubscription = this.createSub(filters, "static");
        }

        await this.routingLogger.logSubscriptionFilters({
            filters,
            whitelistedAuthors: this.whitelistedPubkeys.size,
            trackedProjects: 0,
            trackedAgents: 0,
        });
    }

    /**
     * Update known projects. Recreates the project subscription with new project IDs.
     * Uses `since` on restarts to prevent historical event re-delivery.
     */
    updateKnownProjects(projectIds: string[]): void {
        const knownProjects = new Set(projectIds);

        // Stop existing project subscription
        if (this.projectSubscription) {
            this.projectSubscription.stop();
            this.projectSubscription = null;
        }

        if (knownProjects.size === 0) {
            return;
        }

        const since = this.lastProjectSubCreatedAt ?? undefined;
        this.lastProjectSubCreatedAt = Math.floor(Date.now() / 1000);

        const filters: NDKFilter[] = [];

        const taggedFilter = SubscriptionFilterBuilder.buildProjectTaggedFilter(knownProjects, since);
        if (taggedFilter) filters.push(taggedFilter);

        const reportFilter = SubscriptionFilterBuilder.buildReportFilter(knownProjects);
        if (reportFilter) filters.push(reportFilter);

        if (filters.length > 0) {
            this.projectSubscription = this.createSub(filters, "projects");
            logger.debug("Project subscription updated", {
                projects: knownProjects.size,
                since,
            });
        }
    }

    /**
     * Update agent mentions subscription. Debounced with 2s timer since
     * agent additions can batch (e.g. during project boot with multiple agents).
     */
    updateAgentMentions(pubkeys: Hexpubkey[]): void {
        this.pendingAgentMentionsPubkeys = new Set(pubkeys);

        if (this.agentMentionsTimer) {
            clearTimeout(this.agentMentionsTimer);
        }

        this.agentMentionsTimer = setTimeout(() => {
            this.agentMentionsTimer = null;
            this.applyAgentMentionsUpdate();
        }, 2000);
    }

    private applyAgentMentionsUpdate(): void {
        const pubkeys = this.pendingAgentMentionsPubkeys;
        this.pendingAgentMentionsPubkeys = null;

        if (!pubkeys) return;

        // Stop existing agent mentions subscription
        if (this.agentMentionsSubscription) {
            this.agentMentionsSubscription.stop();
            this.agentMentionsSubscription = null;
        }

        if (pubkeys.size === 0) {
            return;
        }

        const since = this.lastAgentMentionsSubCreatedAt ?? undefined;
        this.lastAgentMentionsSubCreatedAt = Math.floor(Date.now() / 1000);

        const filter = SubscriptionFilterBuilder.buildAgentMentionsFilter(pubkeys, since);
        if (filter) {
            this.agentMentionsSubscription = this.createSub([filter], "agent-mentions");
            logger.debug("Agent mentions subscription updated", {
                agents: pubkeys.size,
                since,
            });
        }
    }

    /**
     * Add a lesson subscription for a specific agent definition ID.
     * Uses NDK groupable to merge with other lesson subscriptions.
     */
    addLessonSubscription(definitionId: string): void {
        if (this.lessonSubscriptions.has(definitionId)) {
            return;
        }

        const filter = SubscriptionFilterBuilder.buildLessonFilter(definitionId);
        const sub = this.ndk.subscribe([filter], {
            closeOnEose: false,
            groupable: true,
            onEvent: (event: NDKEvent) => this.handleEvent(event),
        });

        this.lessonSubscriptions.set(definitionId, sub);
        logger.debug("Lesson subscription added", {
            definitionId: definitionId.substring(0, 12),
            totalLessonSubs: this.lessonSubscriptions.size,
        });
    }

    /**
     * Remove a lesson subscription for a specific agent definition ID.
     */
    removeLessonSubscription(definitionId: string): void {
        const sub = this.lessonSubscriptions.get(definitionId);
        if (sub) {
            sub.stop();
            this.lessonSubscriptions.delete(definitionId);
            logger.debug("Lesson subscription removed", {
                definitionId: definitionId.substring(0, 12),
                totalLessonSubs: this.lessonSubscriptions.size,
            });
        }
    }

    /**
     * Stop all subscriptions.
     */
    stop(): void {
        if (this.agentMentionsTimer) {
            clearTimeout(this.agentMentionsTimer);
            this.agentMentionsTimer = null;
        }

        if (this.recentEventTimer) {
            clearTimeout(this.recentEventTimer);
            this.recentEventTimer = null;
        }
        this.recentEventIds.clear();

        if (this.staticSubscription) {
            this.staticSubscription.stop();
            this.staticSubscription = null;
        }

        if (this.projectSubscription) {
            this.projectSubscription.stop();
            this.projectSubscription = null;
        }

        if (this.agentMentionsSubscription) {
            this.agentMentionsSubscription.stop();
            this.agentMentionsSubscription = null;
        }

        for (const [, sub] of this.lessonSubscriptions) {
            sub.stop();
        }
        this.lessonSubscriptions.clear();

        logger.debug("All subscriptions stopped");
    }

    /**
     * Get current subscription status.
     */
    getStatus(): {
        active: boolean;
        whitelistedPubkeys: number;
        staticActive: boolean;
        projectActive: boolean;
        agentMentionsActive: boolean;
        lessonSubscriptions: number;
    } {
        return {
            active: this.staticSubscription !== null,
            whitelistedPubkeys: this.whitelistedPubkeys.size,
            staticActive: this.staticSubscription !== null,
            projectActive: this.projectSubscription !== null,
            agentMentionsActive: this.agentMentionsSubscription !== null,
            lessonSubscriptions: this.lessonSubscriptions.size,
        };
    }

    /**
     * Create an NDK subscription with the shared event handler.
     */
    private createSub(filters: NDKFilter[], label: string): NDKSubscription {
        const sub = this.ndk.subscribe(filters, {
            closeOnEose: false,
            groupable: false,
            onEvent: (event: NDKEvent) => this.handleEvent(event),
            onEose: () => {
                logger.debug(`Subscription EOSE received [${label}]`);
            },
        });

        return sub;
    }

    /**
     * Handle incoming events from any subscription.
     * Deduplicates across independent subscriptions — the same event can match
     * both the project (#a) and agent-mentions (#p) filters.
     */
    private async handleEvent(event: NDKEvent): Promise<void> {
        if (this.recentEventIds.has(event.id)) return;
        this.recentEventIds.add(event.id);
        this.scheduleEventIdCleanup();

        try {
            await this.eventHandler(event);
        } catch (error) {
            logger.error("Error handling event in subscription", {
                error: error instanceof Error ? error.message : String(error),
                eventId: event.id,
                eventKind: event.kind,
            });
        }
    }

    /**
     * Periodically flush the seen-event set to prevent unbounded growth.
     * Batches cleanup into 60s intervals.
     */
    private scheduleEventIdCleanup(): void {
        if (this.recentEventTimer) return;
        this.recentEventTimer = setTimeout(() => {
            this.recentEventIds.clear();
            this.recentEventTimer = null;
        }, 60_000);
    }
}
