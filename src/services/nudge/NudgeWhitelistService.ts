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
    /** Description of the nudge/skill (full content - truncation is done in presentation layer) */
    description?: string;
    /** Pubkeys that have whitelisted this item (multiple whitelist events can reference same item) */
    whitelistedBy: string[];
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

const REBUILD_DEBOUNCE_MS = 500;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Service for managing nudge/skill whitelists.
 *
 * This service subscribes to kind:14202 events from whitelisted pubkeys,
 * which are NIP-51-like lists that e-tag nudge (kind:4201) and skill (kind:4202) events.
 *
 * The service maintains a cached list of all whitelisted nudges and skills,
 * categorized by their event kind. Cache is built incrementally as events
 * stream in from the subscription — initialization never blocks on EOSE.
 */
export class NudgeSkillWhitelistService {
    private static instance: NudgeSkillWhitelistService;
    private cache: WhitelistCache | null = null;
    private subscription: NDKSubscription | null = null;
    private whitelistPubkeys: Set<string> = new Set();
    private initialized = false;

    /** Latest kind:14202 event per author pubkey (replaceable semantics) */
    private latestWhitelistEvents: Map<string, NDKEvent> = new Map();
    /** Fetched nudge/skill events by ID — avoids re-fetching */
    private referencedEventCache: Map<string, NDKEvent> = new Map();
    /** Debounce timer for coalescing rapid event bursts */
    private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

    private constructor() {}

    static getInstance(): NudgeSkillWhitelistService {
        if (!NudgeSkillWhitelistService.instance) {
            NudgeSkillWhitelistService.instance = new NudgeSkillWhitelistService();
        }
        return NudgeSkillWhitelistService.instance;
    }

    /**
     * Initialize the service with whitelisted pubkeys.
     * Returns immediately — cache starts empty and populates as events stream in.
     */
    initialize(whitelistPubkeys: string[]): void {
        if (this.initialized && this.pubkeysMatch(whitelistPubkeys)) {
            logger.debug("[NudgeSkillWhitelistService] Already initialized with same pubkeys, skipping");
            return;
        }

        this.whitelistPubkeys = new Set(whitelistPubkeys);
        this.initialized = true;
        this.cache = { nudges: [], skills: [], lastUpdated: Date.now() };

        this.startSubscription();

        logger.info("[NudgeSkillWhitelistService] Initialized", {
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
     * Updates the cache incrementally as events arrive.
     */
    private startSubscription(): void {
        if (this.subscription) {
            this.subscription.stop();
        }

        if (this.whitelistPubkeys.size === 0) {
            logger.debug("[NudgeSkillWhitelistService] No whitelisted pubkeys, skipping subscription");
            return;
        }

        const ndk = getNDK();
        const authors = Array.from(this.whitelistPubkeys);

        this.subscription = ndk.subscribe(
            {
                kinds: [NDKKind.NudgeSkillWhitelist],
                authors,
            },
            {
                closeOnEose: false,
                onEvent: (event: NDKEvent) => {
                    this.handleWhitelistEvent(event);
                },
            }
        );

        logger.debug("[NudgeSkillWhitelistService] Started subscription", {
            pubkeyCount: authors.length,
        });
    }

    /**
     * Handle an incoming whitelist event. Applies replaceable semantics
     * (only the latest event per author is kept) and schedules a debounced cache rebuild.
     */
    private handleWhitelistEvent(event: NDKEvent): void {
        const existing = this.latestWhitelistEvents.get(event.pubkey);
        if (existing && existing.created_at !== undefined && event.created_at !== undefined
            && existing.created_at >= event.created_at) {
            return;
        }

        logger.debug("[NudgeSkillWhitelistService] Received whitelist event", {
            eventId: event.id?.substring(0, 12),
            author: event.pubkey.substring(0, 8),
        });

        this.latestWhitelistEvents.set(event.pubkey, event);
        this.scheduleRebuild();
    }

    /**
     * Schedule a debounced cache rebuild. Coalesces rapid event bursts
     * (e.g. the initial subscription replay) into a single rebuild.
     */
    private scheduleRebuild(): void {
        if (this.rebuildTimer) {
            clearTimeout(this.rebuildTimer);
        }
        this.rebuildTimer = setTimeout(() => {
            this.rebuildTimer = null;
            this.rebuildCache().catch(error => {
                logger.error("[NudgeSkillWhitelistService] Failed to rebuild cache", { error });
            });
        }, REBUILD_DEBOUNCE_MS);
    }

    /**
     * Rebuild the cache from all stored whitelist events.
     * Fetches any referenced nudge/skill events not yet in the local cache.
     */
    private async rebuildCache(): Promise<void> {
        const span = tracer.startSpan("tenex.nudge-whitelist.rebuild", {
            attributes: {
                "whitelist.pubkey_count": this.whitelistPubkeys.size,
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                if (this.latestWhitelistEvents.size === 0) {
                    this.cache = { nudges: [], skills: [], lastUpdated: Date.now() };
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.end();
                    return;
                }

                // Collect all e-tagged event IDs and track whitelisters per event
                const eventToWhitelisters: Map<string, Set<string>> = new Map();

                for (const event of this.latestWhitelistEvents.values()) {
                    const eTags = event.tags.filter(tag => tag[0] === "e" && tag[1]);
                    for (const eTag of eTags) {
                        const eventId = eTag[1];
                        if (!eventToWhitelisters.has(eventId)) {
                            eventToWhitelisters.set(eventId, new Set());
                        }
                        eventToWhitelisters.get(eventId)!.add(event.pubkey);
                    }
                }

                if (eventToWhitelisters.size === 0) {
                    this.cache = { nudges: [], skills: [], lastUpdated: Date.now() };
                    span.setAttributes({ "whitelist.item_count": 0 });
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.end();
                    return;
                }

                // Find IDs not yet in our local cache
                const unfetchedIds: string[] = [];
                for (const id of eventToWhitelisters.keys()) {
                    if (!this.referencedEventCache.has(id)) {
                        unfetchedIds.push(id);
                    }
                }

                // Batch-fetch unfetched events with a timeout
                if (unfetchedIds.length > 0) {
                    try {
                        const ndk = getNDK();
                        const fetchPromise = ndk.fetchEvents({ ids: unfetchedIds });
                        const timeoutPromise = new Promise<Set<NDKEvent>>((_, reject) =>
                            setTimeout(() => reject(new Error("fetchEvents timeout")), FETCH_TIMEOUT_MS)
                        );

                        const fetched = await Promise.race([fetchPromise, timeoutPromise]);
                        for (const event of fetched) {
                            this.referencedEventCache.set(event.id, event);
                        }
                    } catch (error) {
                        logger.warn("[NudgeSkillWhitelistService] Fetch timed out or failed, using cached events", {
                            unfetchedCount: unfetchedIds.length,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }

                // Build cache from referencedEventCache + whitelister tracking
                const nudges: WhitelistItem[] = [];
                const skills: WhitelistItem[] = [];

                for (const [eventId, whitelisters] of eventToWhitelisters) {
                    const event = this.referencedEventCache.get(eventId);
                    if (!event) continue;

                    const whitelistedBy = Array.from(whitelisters);

                    if (event.kind === NDKKind.AgentNudge) {
                        nudges.push({
                            eventId: event.id,
                            kind: NDKKind.AgentNudge,
                            name: event.tagValue("title") || event.tagValue("name"),
                            description: event.content,
                            whitelistedBy,
                        });
                    } else if (event.kind === NDKKind.AgentSkill) {
                        skills.push({
                            eventId: event.id,
                            kind: NDKKind.AgentSkill,
                            name: event.tagValue("title") || event.tagValue("name"),
                            description: event.content,
                            whitelistedBy,
                        });
                    }
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

                logger.info("[NudgeSkillWhitelistService] Cache rebuilt", {
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
                logger.error("[NudgeSkillWhitelistService] Failed to rebuild cache", { error });
            }
        });
    }

    /**
     * Get all whitelisted nudges
     */
    getWhitelistedNudges(): WhitelistItem[] {
        if (!this.initialized) {
            logger.warn("[NudgeSkillWhitelistService] getWhitelistedNudges called before initialize() — returning empty list");
        }
        return this.cache?.nudges || [];
    }

    /**
     * Get all whitelisted skills
     */
    getWhitelistedSkills(): WhitelistItem[] {
        if (!this.initialized) {
            logger.warn("[NudgeSkillWhitelistService] getWhitelistedSkills called before initialize() — returning empty list");
        }
        return this.cache?.skills || [];
    }

    /**
     * Get all whitelisted items (both nudges and skills)
     */
    getAllWhitelistedItems(): WhitelistItem[] {
        if (!this.initialized) {
            logger.warn("[NudgeSkillWhitelistService] getAllWhitelistedItems called before initialize() — returning empty list");
        }
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
     * Stop the subscription and clear all state.
     * Used for cleanup during tests or shutdown.
     */
    shutdown(): void {
        if (this.subscription) {
            this.subscription.stop();
            this.subscription = null;
        }
        if (this.rebuildTimer) {
            clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
        this.cache = null;
        this.initialized = false;
        this.whitelistPubkeys.clear();
        this.latestWhitelistEvents.clear();
        this.referencedEventCache.clear();
    }
}
