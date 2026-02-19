import { getNDK } from "@/nostr";
import { NDKKind } from "@/nostr/kinds";
import { logger } from "@/utils/logger";
import type { NDKEvent, NDKSubscription } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.nudge-whitelist-service");

/**
 * Categorized whitelist item - either a nudge or a skill
 */
export interface WhitelistItem {
    /** The event ID of the whitelisted nudge/skill */
    eventId: string;
    /** The kind of the referenced event (4201 for nudge, 4202 for skill) */
    kind: typeof NDKKind.AgentNudge | typeof NDKKind.AgentSkill;
    /** The name of the nudge/skill (from title tag) */
    name?: string;
    /** Description of the nudge/skill (from content) */
    description?: string;
    /** The pubkey that whitelisted this item */
    whitelistedBy: string;
}

/**
 * Cached whitelist data with fetch timestamp
 */
interface WhitelistCache {
    /** Whitelisted nudges (kind:4201) */
    nudges: WhitelistItem[];
    /** Whitelisted skills (kind:4202) */
    skills: WhitelistItem[];
    /** When this cache was last updated */
    lastUpdated: number;
}

/**
 * Service for managing nudge/skill whitelists.
 *
 * This service subscribes to kind:14202 events from whitelisted pubkeys,
 * which are NIP-51-like lists that e-tag nudge (kind:4201) and skill (kind:4202) events.
 *
 * The service maintains a cached list of all whitelisted nudges and skills,
 * categorized by their event kind.
 */
export class NudgeWhitelistService {
    private static instance: NudgeWhitelistService;
    private cache: WhitelistCache | null = null;
    private subscription: NDKSubscription | null = null;
    private whitelistPubkeys: Set<string> = new Set();
    private initialized = false;

    private constructor() {}

    static getInstance(): NudgeWhitelistService {
        if (!NudgeWhitelistService.instance) {
            NudgeWhitelistService.instance = new NudgeWhitelistService();
        }
        return NudgeWhitelistService.instance;
    }

    /**
     * Initialize the service with whitelisted pubkeys.
     * This should be called during project boot with the project owner's pubkey
     * and any additional trusted pubkeys.
     */
    async initialize(whitelistPubkeys: string[]): Promise<void> {
        if (this.initialized && this.pubkeysMatch(whitelistPubkeys)) {
            logger.debug("[NudgeWhitelistService] Already initialized with same pubkeys, skipping");
            return;
        }

        this.whitelistPubkeys = new Set(whitelistPubkeys);
        this.initialized = true;

        await this.refresh();
        this.startSubscription();

        logger.info("[NudgeWhitelistService] Initialized", {
            pubkeyCount: whitelistPubkeys.length,
        });
    }

    /**
     * Check if the given pubkeys match the currently configured whitelist
     */
    private pubkeysMatch(newPubkeys: string[]): boolean {
        if (newPubkeys.length !== this.whitelistPubkeys.size) return false;
        return newPubkeys.every(pk => this.whitelistPubkeys.has(pk));
    }

    /**
     * Start a subscription to kind:14202 events from whitelisted pubkeys.
     * Updates the cache when new events arrive.
     */
    private startSubscription(): void {
        if (this.subscription) {
            this.subscription.stop();
        }

        if (this.whitelistPubkeys.size === 0) {
            logger.debug("[NudgeWhitelistService] No whitelisted pubkeys, skipping subscription");
            return;
        }

        const ndk = getNDK();
        const authors = Array.from(this.whitelistPubkeys);

        this.subscription = ndk.subscribe(
            {
                kinds: [NDKKind.NudgeSkillWhitelist],
                authors,
            },
            { closeOnEose: false }
        );

        this.subscription.on("event", async (event: NDKEvent) => {
            logger.debug("[NudgeWhitelistService] Received whitelist event", {
                eventId: event.id?.substring(0, 12),
                author: event.pubkey.substring(0, 8),
            });
            // Refresh cache when new events arrive
            await this.refresh();
        });

        logger.debug("[NudgeWhitelistService] Started subscription", {
            pubkeyCount: authors.length,
        });
    }

    /**
     * Refresh the cache by fetching all kind:14202 events from whitelisted pubkeys
     * and resolving the referenced nudge/skill events.
     */
    async refresh(): Promise<void> {
        const span = tracer.startSpan("tenex.nudge-whitelist.refresh", {
            attributes: {
                "whitelist.pubkey_count": this.whitelistPubkeys.size,
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                if (this.whitelistPubkeys.size === 0) {
                    this.cache = { nudges: [], skills: [], lastUpdated: Date.now() };
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.end();
                    return;
                }

                const ndk = getNDK();
                const authors = Array.from(this.whitelistPubkeys);

                // Fetch all whitelist events
                const whitelistEvents = await ndk.fetchEvents({
                    kinds: [NDKKind.NudgeSkillWhitelist],
                    authors,
                });

                // Collect all e-tagged event IDs
                const referencedEventIds: Set<string> = new Set();
                const eventToWhitelister: Map<string, string> = new Map();

                for (const event of whitelistEvents) {
                    const eTags = event.tags.filter(tag => tag[0] === "e" && tag[1]);
                    for (const eTag of eTags) {
                        const eventId = eTag[1];
                        referencedEventIds.add(eventId);
                        eventToWhitelister.set(eventId, event.pubkey);
                    }
                }

                if (referencedEventIds.size === 0) {
                    this.cache = { nudges: [], skills: [], lastUpdated: Date.now() };
                    span.setAttributes({ "whitelist.item_count": 0 });
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.end();
                    return;
                }

                // Fetch all referenced events to categorize them
                const referencedEvents = await ndk.fetchEvents({
                    ids: Array.from(referencedEventIds),
                });

                const nudges: WhitelistItem[] = [];
                const skills: WhitelistItem[] = [];

                for (const event of referencedEvents) {
                    const whitelistedBy = eventToWhitelister.get(event.id) || "unknown";

                    const item: WhitelistItem = {
                        eventId: event.id,
                        kind: event.kind as typeof NDKKind.AgentNudge | typeof NDKKind.AgentSkill,
                        name: event.tagValue("title") || event.tagValue("name"),
                        description: event.content?.substring(0, 200),
                        whitelistedBy,
                    };

                    if (event.kind === NDKKind.AgentNudge) {
                        nudges.push(item);
                    } else if (event.kind === NDKKind.AgentSkill) {
                        skills.push(item);
                    }
                    // Ignore other kinds - they shouldn't be in the whitelist but we don't fail
                }

                this.cache = {
                    nudges,
                    skills,
                    lastUpdated: Date.now(),
                };

                span.setAttributes({
                    "whitelist.nudge_count": nudges.length,
                    "whitelist.skill_count": skills.length,
                    "whitelist.item_count": nudges.length + skills.length,
                });

                logger.info("[NudgeWhitelistService] Cache refreshed", {
                    nudgeCount: nudges.length,
                    skillCount: skills.length,
                });

                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: (error as Error).message,
                });
                span.end();
                logger.error("[NudgeWhitelistService] Failed to refresh cache", { error });
            }
        });
    }

    /**
     * Get all whitelisted nudges
     */
    getWhitelistedNudges(): WhitelistItem[] {
        return this.cache?.nudges || [];
    }

    /**
     * Get all whitelisted skills
     */
    getWhitelistedSkills(): WhitelistItem[] {
        return this.cache?.skills || [];
    }

    /**
     * Get all whitelisted items (both nudges and skills)
     */
    getAllWhitelistedItems(): WhitelistItem[] {
        if (!this.cache) return [];
        return [...this.cache.nudges, ...this.cache.skills];
    }

    /**
     * Check if a nudge event ID is whitelisted
     */
    isNudgeWhitelisted(eventId: string): boolean {
        return this.cache?.nudges.some(n => n.eventId === eventId) || false;
    }

    /**
     * Check if a skill event ID is whitelisted
     */
    isSkillWhitelisted(eventId: string): boolean {
        return this.cache?.skills.some(s => s.eventId === eventId) || false;
    }

    /**
     * Get a whitelisted nudge by event ID
     */
    getNudge(eventId: string): WhitelistItem | undefined {
        return this.cache?.nudges.find(n => n.eventId === eventId);
    }

    /**
     * Get the last cache update time
     */
    getLastUpdated(): number | null {
        return this.cache?.lastUpdated || null;
    }

    /**
     * Stop the subscription and clear the cache.
     * Used for cleanup during tests or shutdown.
     */
    shutdown(): void {
        if (this.subscription) {
            this.subscription.stop();
            this.subscription = null;
        }
        this.cache = null;
        this.initialized = false;
        this.whitelistPubkeys.clear();
    }
}
