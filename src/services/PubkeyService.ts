import { getNDK } from "@/nostr";
import { getProjectContext, isProjectContextInitialized } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";

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
    private readonly DEFAULT_USER_NAME = "User";

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
        // First, check if it's an agent
        const agentSlug = this.getAgentSlug(pubkey);
        if (agentSlug) {
            return agentSlug;
        }

        // It's a user - fetch their profile
        const profile = await this.getUserProfile(pubkey);
        return this.extractDisplayName(profile);
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
            return this.extractDisplayName(cached.profile);
        }

        // Return default if nothing found
        return this.DEFAULT_USER_NAME;
    }

    /**
     * Get agent slug for a pubkey if it belongs to an agent
     */
    private getAgentSlug(pubkey: Hexpubkey): string | undefined {
        if (!isProjectContextInitialized()) {
            return undefined;
        }

        const projectCtx = getProjectContext();

        // Check all agents
        for (const [slug, agent] of projectCtx.agents) {
            if (agent.pubkey === pubkey) {
                return slug;
            }
        }

        return undefined;
    }

    /**
     * Fetch user profile from kind:0 event
     */
    private async getUserProfile(pubkey: Hexpubkey): Promise<UserProfile> {
        // Check cache first
        const cached = this.userProfileCache.get(pubkey);
        if (cached && Date.now() < cached.ttl) {
            return cached.profile;
        }

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

                return profile;
            }
        } catch (error) {
            logger.warn("[PUBKEY_NAME_REPO] Failed to fetch user profile", {
                pubkey,
                error,
            });
        }

        // Return empty profile if fetch failed
        const emptyProfile: UserProfile = { fetchedAt: Date.now() };

        // Cache even empty results to avoid repeated failed fetches
        this.userProfileCache.set(pubkey, {
            profile: emptyProfile,
            ttl: Date.now() + this.CACHE_TTL_MS,
        });

        return emptyProfile;
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
     */
    private extractDisplayName(profile: UserProfile): string {
        // Priority: name > display_name > username > default
        if (profile.name?.trim()) {
            return profile.name.trim();
        }
        if (profile.display_name?.trim()) {
            return profile.display_name.trim();
        }
        if (profile.username?.trim()) {
            return profile.username.trim();
        }
        return this.DEFAULT_USER_NAME;
    }

    /**
     * Force refresh a user's profile (bypass cache)
     */
    async refreshUserProfile(pubkey: Hexpubkey): Promise<UserProfile> {
        // Remove from cache to force fresh fetch
        this.userProfileCache.delete(pubkey);
        return this.getUserProfile(pubkey);
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
