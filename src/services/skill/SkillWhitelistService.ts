import { getNDK } from "@/nostr";
import { NDKKind } from "@/nostr/kinds";
import { logger } from "@/utils/logger";
import type { NDKEvent, NDKSubscription } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import { shortenEventId, shortenOptionalEventId } from "@/utils/conversation-id";
import { assignCapabilityIdentifiers } from "@/utils/capability-identifiers";
import type { SkillData } from "./types";

const tracer = trace.getTracer("tenex.skill-whitelist-service");

/**
 * Whitelisted skill item (kind:4202)
 */
export interface WhitelistItem {
    /** The event ID of the whitelisted skill */
    eventId: string;
    /** Prompt-facing identifier derived from d-tag/name/title, falling back to shortId */
    identifier?: string;
    /** Short event ID kept locally for fallback mapping/debugging */
    shortId?: string;
    /** The kind of the referenced event */
    kind: typeof NDKKind.AgentSkill;
    /** The name of the skill (from title tag) */
    name?: string;
    /** Description of the skill (full content - truncation is done in presentation layer) */
    description?: string;
    /** Pubkeys that have whitelisted this item (multiple whitelist events can reference same item) */
    whitelistedBy: string[];
}

function getSkillDescription(event: NDKEvent): string {
    return (
        event.tagValue("description") ||
        event.tagValue("summary") ||
        event.content
    );
}

/**
 * Cached whitelist data with fetch timestamp
 */
interface WhitelistCache {
    /** All whitelisted skills */
    skills: WhitelistItem[];
    /** When this cache was last updated */
    lastUpdated: number;
}

const REBUILD_DEBOUNCE_MS = 500;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Service for managing skill whitelists.
 *
 * This service subscribes to kind:14202 events from whitelisted pubkeys,
 * which are NIP-51-like lists that e-tag skill (kind:4202) events.
 *
 * The service maintains a cached list
 * of all whitelisted skills. Cache is built incrementally as events stream in
 * from the subscription — initialization never blocks on EOSE.
 */
export class SkillWhitelistService {
    private static instance: SkillWhitelistService;
    private cache: WhitelistCache | null = null;
    private installedSkills: SkillData[] = [];
    private subscription: NDKSubscription | null = null;
    private whitelistPubkeys: Set<string> = new Set();
    private initialized = false;

    /** Latest kind:14202 event per author pubkey (replaceable semantics) */
    private latestWhitelistEvents: Map<string, NDKEvent> = new Map();
    /** Fetched skill events by ID — avoids re-fetching */
    private referencedEventCache: Map<string, NDKEvent> = new Map();
    /** Debounce timer for coalescing rapid event bursts */
    private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    private uninitializedReadMethods: Set<string> = new Set();
    private cacheUpdatedListeners = new Set<() => void | Promise<void>>();

    private constructor() {}

    static getInstance(): SkillWhitelistService {
        if (!SkillWhitelistService.instance) {
            SkillWhitelistService.instance = new SkillWhitelistService();
        }
        return SkillWhitelistService.instance;
    }

    onCacheUpdated(listener: () => void | Promise<void>): () => void {
        this.cacheUpdatedListeners.add(listener);
        return () => this.cacheUpdatedListeners.delete(listener);
    }

    /**
     * Initialize the service with whitelisted pubkeys.
     * Returns immediately — cache starts empty and populates as events stream in.
     */
    initialize(whitelistPubkeys: string[]): void {
        if (this.initialized && this.pubkeysMatch(whitelistPubkeys)) {
            logger.debug("[SkillWhitelistService] Already initialized with same pubkeys, skipping");
            return;
        }

        this.whitelistPubkeys = new Set(whitelistPubkeys);
        this.initialized = true;
        this.cache = { skills: [], lastUpdated: Date.now() };
        this.installedSkills = [];

        this.startSubscription();

        logger.info("[SkillWhitelistService] Initialized", {
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
            logger.debug("[SkillWhitelistService] No whitelisted pubkeys, skipping subscription");
            return;
        }

        const ndk = getNDK();
        const authors = Array.from(this.whitelistPubkeys);

        this.subscription = ndk.subscribe(
            {
                kinds: [NDKKind.SkillWhitelist],
                authors,
            },
            {
                closeOnEose: false,
                onEvent: (event: NDKEvent) => {
                    this.handleWhitelistEvent(event);
                },
            }
        );

        logger.debug("[SkillWhitelistService] Started subscription", {
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

        logger.debug("[SkillWhitelistService] Received whitelist event", {
            eventId: shortenOptionalEventId(event.id),
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
                logger.error("[SkillWhitelistService] Failed to rebuild cache", { error });
            });
        }, REBUILD_DEBOUNCE_MS);
    }

    /**
     * Rebuild the cache from all stored whitelist events.
     * Fetches any referenced skill events not yet in the local cache.
     */
    private async rebuildCache(): Promise<void> {
        const span = tracer.startSpan("tenex.skill-whitelist.rebuild", {
            attributes: {
                "whitelist.pubkey_count": this.whitelistPubkeys.size,
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                if (this.latestWhitelistEvents.size === 0) {
                    this.cache = { skills: [], lastUpdated: Date.now() };
                    await this.notifyCacheUpdated();
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
                        eventToWhitelisters.get(eventId)?.add(event.pubkey);
                    }
                }

                if (eventToWhitelisters.size === 0) {
                    this.cache = { skills: [], lastUpdated: Date.now() };
                    await this.notifyCacheUpdated();
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
                        logger.warn("[SkillWhitelistService] Fetch timed out or failed, using cached events", {
                            unfetchedCount: unfetchedIds.length,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }

                interface WhitelistDraft extends WhitelistItem {
                    sourceDTag?: string;
                    sourceName?: string;
                    sourceTitle?: string;
                }
                const skillDrafts: WhitelistDraft[] = [];

                for (const [eventId, whitelisters] of eventToWhitelisters) {
                    const event = this.referencedEventCache.get(eventId);
                    if (!event) continue;

                    const whitelistedBy = Array.from(whitelisters);
                    const dTag = event.tagValue("d") || undefined;
                    const title = event.tagValue("title") || undefined;
                    const name = event.tagValue("name") || undefined;
                    const shortId = shortenEventId(event.id);

                    if (event.kind === NDKKind.AgentSkill) {
                        skillDrafts.push({
                            eventId: event.id,
                            kind: event.kind as typeof NDKKind.AgentSkill,
                            name: title || name || dTag,
                            shortId,
                            description: getSkillDescription(event),
                            whitelistedBy,
                            sourceDTag: dTag,
                            sourceName: name,
                            sourceTitle: title,
                        });
                    }
                }

                const skillIdentifiers = assignCapabilityIdentifiers(
                    skillDrafts.map((item) => ({
                        eventId: item.eventId,
                        dTag: item.sourceDTag,
                        name: item.sourceName,
                        title: item.sourceTitle,
                    }))
                );

                const skills: WhitelistItem[] = skillDrafts.map((draft) => ({
                    eventId: draft.eventId,
                    kind: draft.kind,
                    name: draft.name,
                    description: draft.description,
                    whitelistedBy: draft.whitelistedBy,
                    identifier:
                        skillIdentifiers.get(draft.eventId)?.identifier ?? draft.shortId,
                    shortId: skillIdentifiers.get(draft.eventId)?.shortId ?? draft.shortId,
                }));

                this.cache = {
                    skills,
                    lastUpdated: Date.now(),
                };
                await this.notifyCacheUpdated();

                span.setAttributes({
                    "whitelist.skill_count": skills.length,
                    "whitelist.item_count": skills.length,
                });

                logger.info("[SkillWhitelistService] Cache rebuilt", {
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
                logger.error("[SkillWhitelistService] Failed to rebuild cache", { error });
            }
        });
    }

    /**
     * Get all whitelisted skills
     */
    getWhitelistedSkills(): WhitelistItem[] {
        if (!this.initialized) {
            this.logUninitializedRead("getWhitelistedSkills");
        }
        return this.cache?.skills || [];
    }

    /**
     * Get all whitelisted items
     */
    getAllWhitelistedItems(): WhitelistItem[] {
        if (!this.initialized) {
            this.logUninitializedRead("getAllWhitelistedItems");
        }
        return this.cache?.skills || [];
    }

    /**
     * Get the currently cached installed skills used for alias expansion.
     */
    getInstalledSkills(): SkillData[] {
        return this.installedSkills;
    }

    /**
     * Update the cached installed skills used for alias expansion.
     */
    setInstalledSkills(skills: SkillData[]): void {
        this.installedSkills = skills.map((skill) => ({
            ...skill,
            installedFiles: skill.installedFiles.map((file) => ({ ...file })),
            toolNames: skill.toolNames ? [...skill.toolNames] : undefined,
        }));
    }

    private async notifyCacheUpdated(): Promise<void> {
        for (const listener of this.cacheUpdatedListeners) {
            try {
                await listener();
            } catch (error) {
                logger.warn("[SkillWhitelistService] Cache update listener failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private logUninitializedRead(methodName: string): void {
        if (this.uninitializedReadMethods.has(methodName)) {
            return;
        }
        this.uninitializedReadMethods.add(methodName);
        logger.debug(
            `[SkillWhitelistService] ${methodName} called before initialize() — returning empty list`
        );
    }

    /**
     * Check if a skill event ID is whitelisted
     */
    isSkillWhitelisted(eventId: string): boolean {
        return this.cache?.skills.some(s => s.eventId === eventId) || false;
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
        this.installedSkills = [];
        this.initialized = false;
        this.whitelistPubkeys.clear();
        this.latestWhitelistEvents.clear();
        this.referencedEventCache.clear();
        this.uninitializedReadMethods.clear();
        this.cacheUpdatedListeners.clear();
    }
}
