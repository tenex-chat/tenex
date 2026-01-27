import { getNDK } from "@/nostr";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { logger } from "@/utils/logger";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.pubkey-service");

interface UserProfile {
    name?: string;
    display_name?: string;
    username?: string;
    about?: string;
    picture?: string;
    fetchedAt: number;
}

interface CacheEntry {
    profile: UserProfile;
    ttl: number;
}

/**
 * Central repository for mapping pubkeys to human-readable names.
 * Handles both agent pubkeys (mapped to slugs) and user pubkeys (fetched from kind:0 events).
 */
export class PubkeyService {
    private static instance: PubkeyService;

    private userProfileCache: Map<Hexpubkey, CacheEntry> = new Map();
    private readonly CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

    private constructor() {}

    /**
     * Get singleton instance
     */
    static getInstance(): PubkeyService {
        if (!PubkeyService.instance) {
            PubkeyService.instance = new PubkeyService();
        }
        return PubkeyService.instance;
    }

    /**
     * Get a display name for any pubkey (agent or user)
     */
    async getName(pubkey: Hexpubkey): Promise<string> {
        return tracer.startActiveSpan("tenex.pubkey.get_name", async (span) => {
            try {
                span.setAttribute("pubkey", pubkey.substring(0, 8));

                // First, check if it's an agent
                const agentSlug = this.getAgentSlug(pubkey);
                if (agentSlug) {
                    span.setAttribute("resolved_from", "agent_registry");
                    span.setAttribute("display_name", agentSlug);
                    return agentSlug;
                }

                // It's a user - fetch their profile
                const profile = await this.getUserProfile(pubkey);
                const displayName = this.extractDisplayName(profile, pubkey);
                span.setAttribute("resolved_from", "user_profile");
                span.setAttribute("display_name", displayName);
                return displayName;
            } finally {
                span.end();
            }
        });
    }

    /**
     * Get a display name synchronously (uses cache only, no fetching)
     */
    getNameSync(pubkey: Hexpubkey): string {
        // First, check if it's an agent
        const agentSlug = this.getAgentSlug(pubkey);
        if (agentSlug) {
            return agentSlug;
        }

        // Check cache for user profile
        const cached = this.userProfileCache.get(pubkey);
        if (cached && Date.now() < cached.ttl) {
            return this.extractDisplayName(cached.profile, pubkey);
        }

        // Return shortened pubkey as fallback using shared PREFIX_LENGTH constant
        return pubkey.substring(0, PREFIX_LENGTH);
    }

    /**
     * Get agent slug for a pubkey if it belongs to an agent.
     * Uses AgentRegistry's getAgentByPubkey for efficient O(1) lookup.
     */
    private getAgentSlug(pubkey: Hexpubkey): string | undefined {
        if (!isProjectContextInitialized()) {
            return undefined;
        }

        const projectCtx = getProjectContext();

        // Use direct pubkey lookup from AgentRegistry (O(1) instead of O(n))
        const agent = projectCtx.getAgentByPubkey(pubkey);
        if (agent) {
            return agent.slug;
        }

        return undefined;
    }

    /**
     * Fetch user profile from kind:0 event
     */
    private async getUserProfile(pubkey: Hexpubkey): Promise<UserProfile> {
        return tracer.startActiveSpan("tenex.pubkey.fetch_profile", async (span) => {
            try {
                span.setAttribute("pubkey", pubkey.substring(0, 8));

                // Check cache first
                const cached = this.userProfileCache.get(pubkey);
                if (cached && Date.now() < cached.ttl) {
                    span.setAttribute("cache.status", "hit");
                    span.setAttribute("profile.name", cached.profile.name ?? "");
                    span.setAttribute("profile.display_name", cached.profile.display_name ?? "");
                    return cached.profile;
                }

                span.setAttribute("cache.status", "miss");

                try {
                    const ndk = getNDK();

                    // Fetch kind:0 (metadata) event for this pubkey
                    const profileEvent = await ndk.fetchEvent({
                        kinds: [0],
                        authors: [pubkey],
                    });

                    if (profileEvent) {
                        const profile = this.parseProfileEvent(profileEvent);

                        // Cache the result
                        this.userProfileCache.set(pubkey, {
                            profile,
                            ttl: Date.now() + this.CACHE_TTL_MS,
                        });

                        logger.debug("[PUBKEY_NAME_REPO] Fetched user profile", {
                            pubkey,
                            name: profile.name,
                            display_name: profile.display_name,
                        });

                        span.setAttribute("profile.name", profile.name ?? "");
                        span.setAttribute("profile.display_name", profile.display_name ?? "");
                        span.setAttribute("profile.empty", false);
                        return profile;
                    }
                } catch (error) {
                    logger.warn("[PUBKEY_NAME_REPO] Failed to fetch user profile", {
                        pubkey,
                        error,
                    });
                    span.setAttribute("profile.fetch_error", error instanceof Error ? error.message : String(error));
                }

                // Return empty profile if fetch failed
                const emptyProfile: UserProfile = { fetchedAt: Date.now() };

                // Cache even empty results to avoid repeated failed fetches
                this.userProfileCache.set(pubkey, {
                    profile: emptyProfile,
                    ttl: Date.now() + this.CACHE_TTL_MS,
                });

                span.setAttribute("profile.empty", true);
                return emptyProfile;
            } finally {
                span.end();
            }
        });
    }

    /**
     * Parse profile data from kind:0 event
     */
    private parseProfileEvent(event: NDKEvent): UserProfile {
        try {
            const content = JSON.parse(event.content);
            return {
                name: content.name,
                display_name: content.display_name,
                username: content.username,
                about: content.about,
                picture: content.picture,
                fetchedAt: Date.now(),
            };
        } catch (error) {
            logger.warn("[PUBKEY_NAME_REPO] Failed to parse profile content", {
                eventId: event.id,
                error,
            });
            return { fetchedAt: Date.now() };
        }
    }

    /**
     * Extract the best display name from a profile
     * @param profile The user profile to extract a name from
     * @param pubkeyFallback Optional pubkey to use as fallback if no name is found
     */
    private extractDisplayName(profile: UserProfile, pubkeyFallback?: string): string {
        // Priority: name > display_name > username > shortened pubkey
        if (profile.name?.trim()) {
            return profile.name.trim();
        }
        if (profile.display_name?.trim()) {
            return profile.display_name.trim();
        }
        if (profile.username?.trim()) {
            return profile.username.trim();
        }
        // Fallback to shortened pubkey if available
        if (pubkeyFallback) {
            return pubkeyFallback.substring(0, PREFIX_LENGTH);
        }
        // This shouldn't happen as callers should provide pubkeyFallback
        return "Unknown";
    }

    /**
     * Force refresh a user's profile (bypass cache)
     */
    async refreshUserProfile(pubkey: Hexpubkey): Promise<UserProfile> {
        // Remove from cache to force fresh fetch
        this.userProfileCache.delete(pubkey);
        return this.getUserProfile(pubkey);
    }

    private readonly MAX_CONCURRENT_FETCHES = 10;

    /**
     * Warm the cache for multiple user pubkeys.
     * This pre-fetches kind:0 profiles so that getNameSync() returns real names
     * instead of shortened pubkeys.
     *
     * @param pubkeys Array of pubkeys to warm the cache for
     * @returns Map of pubkey to resolved display name
     */
    async warmUserProfiles(pubkeys: Hexpubkey[]): Promise<Map<Hexpubkey, string>> {
        return tracer.startActiveSpan("tenex.pubkey.warm_profiles", async (span) => {
            try {
                const results = new Map<Hexpubkey, string>();

                // Deduplicate pubkeys and filter out agent pubkeys (they don't need profile warming)
                const uniquePubkeys = [...new Set(pubkeys)];
                const userPubkeys = uniquePubkeys.filter((pk) => !this.getAgentSlug(pk));

                span.setAttribute("pubkey.count", pubkeys.length);
                span.setAttribute("user_pubkey.count", userPubkeys.length);
                span.setAttribute("batch.size", this.MAX_CONCURRENT_FETCHES);

                if (userPubkeys.length === 0) {
                    span.setAttribute("profiles.warmed_count", 0);
                    return results;
                }

                logger.debug("[PUBKEY_SERVICE] Warming user profile cache", {
                    count: userPubkeys.length,
                    dedupedFrom: pubkeys.length,
                });

                // Fetch in batches to avoid thundering-herd fetches
                let batchNumber = 0;
                for (let i = 0; i < userPubkeys.length; i += this.MAX_CONCURRENT_FETCHES) {
                    batchNumber++;
                    const batch = userPubkeys.slice(i, i + this.MAX_CONCURRENT_FETCHES);

                    await tracer.startActiveSpan("tenex.pubkey.warm_batch", async (batchSpan) => {
                        try {
                            batchSpan.setAttribute("batch.number", batchNumber);
                            batchSpan.setAttribute("batch.size", batch.length);

                            await Promise.all(
                                batch.map(async (pubkey) => {
                                    try {
                                        const name = await this.getName(pubkey);
                                        results.set(pubkey, name);
                                    } catch (error) {
                                        logger.warn("[PUBKEY_SERVICE] Failed to warm profile", {
                                            pubkey: pubkey.substring(0, PREFIX_LENGTH),
                                            error: error instanceof Error ? error.message : String(error),
                                        });
                                        results.set(pubkey, pubkey.substring(0, PREFIX_LENGTH));
                                    }
                                })
                            );
                        } finally {
                            batchSpan.end();
                        }
                    });
                }

                logger.debug("[PUBKEY_SERVICE] Profile cache warmed", {
                    count: results.size,
                });

                span.setAttribute("profiles.warmed_count", results.size);
                return results;
            } finally {
                span.end();
            }
        });
    }

    /**
     * Clear the entire cache
     */
    clearCache(): void {
        this.userProfileCache.clear();
        logger.debug("[PUBKEY_NAME_REPO] Cache cleared");
    }

    /**
     * Get cache statistics for debugging
     */
    getCacheStats(): { size: number; entries: string[] } {
        return {
            size: this.userProfileCache.size,
            entries: Array.from(this.userProfileCache.keys()),
        };
    }
}

// Export singleton instance getter for convenience
export const getPubkeyService = (): PubkeyService =>
    PubkeyService.getInstance();
