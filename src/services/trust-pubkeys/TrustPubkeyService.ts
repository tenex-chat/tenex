import { config } from "@/services/ConfigService";
import { projectContextStore } from "@/services/projects";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Reason why a pubkey is trusted
 */
export type TrustReason = "whitelisted" | "backend" | "agent";

/**
 * Result of a trust check
 */
export interface TrustResult {
    /** Whether the pubkey is trusted */
    trusted: boolean;
    /** Why the pubkey is trusted (only set if trusted is true) */
    reason?: TrustReason;
}

/**
 * TrustPubkeyService determines if a given pubkey should be heeded or ignored.
 *
 * A pubkey is trusted if it is:
 * - In the whitelisted pubkeys from config
 * - The backend's own pubkey
 * - An agent in the system (registered in ProjectContext)
 *
 * Trust precedence (highest to lowest): whitelisted > backend > agent
 */
export class TrustPubkeyService {
    private static instance: TrustPubkeyService;

    /** Cached backend pubkey to avoid repeated async calls */
    private cachedBackendPubkey?: Hexpubkey;

    private constructor() {}

    /**
     * Get singleton instance
     */
    static getInstance(): TrustPubkeyService {
        if (!TrustPubkeyService.instance) {
            TrustPubkeyService.instance = new TrustPubkeyService();
        }
        return TrustPubkeyService.instance;
    }

    /**
     * Check if a pubkey is trusted.
     * Returns a TrustResult with the trust status and reason.
     *
     * @param pubkey The pubkey to check (hex format)
     * @returns TrustResult indicating if trusted and why
     */
    async isTrusted(pubkey: Hexpubkey): Promise<TrustResult> {
        // 1. Check whitelisted pubkeys from config
        if (this.isWhitelisted(pubkey)) {
            logger.debug("[TRUST_PUBKEY] Pubkey trusted: whitelisted", {
                pubkey: pubkey.substring(0, 12),
            });
            return { trusted: true, reason: "whitelisted" };
        }

        // 2. Check if it's the backend's own pubkey (uses cache)
        const backendPubkey = await this.getBackendPubkey();
        if (backendPubkey && pubkey === backendPubkey) {
            logger.debug("[TRUST_PUBKEY] Pubkey trusted: backend", {
                pubkey: pubkey.substring(0, 12),
            });
            return { trusted: true, reason: "backend" };
        }

        // 3. Check if it's an agent in the system
        if (this.isAgentPubkey(pubkey)) {
            logger.debug("[TRUST_PUBKEY] Pubkey trusted: agent", {
                pubkey: pubkey.substring(0, 12),
            });
            return { trusted: true, reason: "agent" };
        }

        // Not trusted
        logger.debug("[TRUST_PUBKEY] Pubkey not trusted", {
            pubkey: pubkey.substring(0, 12),
        });
        return { trusted: false };
    }

    /**
     * Check if an NDKEvent is from a trusted source.
     * Extracts the pubkey from the event and uses the existing pubkey-based trust logic.
     *
     * @param event The NDKEvent to check
     * @returns TrustResult indicating if the event's author is trusted and why
     */
    async isTrustedEvent(event: NDKEvent): Promise<TrustResult> {
        const pubkey = this.getEventPubkey(event);

        if (!pubkey) {
            return { trusted: false };
        }

        return this.isTrusted(pubkey);
    }

    /**
     * Synchronous version of isTrustedEvent - uses cached backend pubkey.
     * Note: May return false negative for backend pubkey if cache is not initialized.
     * Use initializeBackendPubkeyCache() first if you need sync checks.
     *
     * @param event The NDKEvent to check
     * @returns TrustResult indicating if the event's author is trusted and why
     */
    isTrustedEventSync(event: NDKEvent): TrustResult {
        const pubkey = this.getEventPubkey(event);

        if (!pubkey) {
            return { trusted: false };
        }

        return this.isTrustedSync(pubkey);
    }

    /**
     * Synchronous version of isTrusted - uses cached backend pubkey.
     * Note: May return false negative for backend pubkey if cache is not initialized.
     * Use initializeBackendPubkeyCache() first if you need sync checks.
     *
     * @param pubkey The pubkey to check (hex format)
     * @returns TrustResult indicating if trusted and why
     */
    isTrustedSync(pubkey: Hexpubkey): TrustResult {
        // 1. Check whitelisted pubkeys from config
        if (this.isWhitelisted(pubkey)) {
            return { trusted: true, reason: "whitelisted" };
        }

        // 2. Check cached backend pubkey
        if (this.cachedBackendPubkey && pubkey === this.cachedBackendPubkey) {
            return { trusted: true, reason: "backend" };
        }

        // 3. Check if it's an agent in the system
        if (this.isAgentPubkey(pubkey)) {
            return { trusted: true, reason: "agent" };
        }

        return { trusted: false };
    }

    /**
     * Initialize the backend pubkey cache for sync operations.
     * Call this during startup if you need to use isTrustedSync.
     */
    async initializeBackendPubkeyCache(): Promise<void> {
        const pubkey = await this.getBackendPubkey();
        if (pubkey) {
            logger.debug("[TRUST_PUBKEY] Backend pubkey cache initialized", {
                pubkey: pubkey.substring(0, 12),
            });
        }
        // Note: getBackendPubkey already logs debug message on failure
    }

    /**
     * Get all currently trusted pubkeys.
     * Useful for debugging or displaying trust status.
     *
     * De-duplicates entries and enforces precedence (whitelisted > backend > agent).
     * If a pubkey appears in multiple trust sources, only the highest precedence reason is returned.
     *
     * @returns Array of trusted pubkeys with their trust reasons
     */
    async getAllTrustedPubkeys(): Promise<Array<{ pubkey: Hexpubkey; reason: TrustReason }>> {
        // Use a Map to de-duplicate, storing by pubkey with highest precedence reason
        const trustedMap = new Map<Hexpubkey, TrustReason>();

        // Priority order: whitelisted (1) > backend (2) > agent (3)
        // Lower number = higher priority, so we only set if not already present (first wins)

        // 1. Add whitelisted pubkeys (highest priority)
        const whitelisted = this.getWhitelistedPubkeys();
        for (const pubkey of whitelisted) {
            if (!trustedMap.has(pubkey)) {
                trustedMap.set(pubkey, "whitelisted");
            }
        }

        // 2. Add backend pubkey (second priority, uses cache)
        const backendPubkey = await this.getBackendPubkey();
        if (backendPubkey && !trustedMap.has(backendPubkey)) {
            trustedMap.set(backendPubkey, "backend");
        }

        // 3. Add agent pubkeys (lowest priority)
        const projectCtx = projectContextStore.getContext();
        if (projectCtx) {
            for (const [_slug, agent] of projectCtx.agents) {
                if (agent.pubkey && !trustedMap.has(agent.pubkey)) {
                    trustedMap.set(agent.pubkey, "agent");
                }
            }
        }

        // Convert map to array
        return Array.from(trustedMap.entries()).map(([pubkey, reason]) => ({
            pubkey,
            reason,
        }));
    }

    // =====================================================================================
    // PRIVATE HELPERS
    // =====================================================================================

    /**
     * Extract and validate pubkey from an NDKEvent.
     * Returns undefined if the event has no pubkey or an empty pubkey.
     *
     * @param event The NDKEvent to extract pubkey from
     * @returns The pubkey or undefined if not present/valid
     */
    private getEventPubkey(event: NDKEvent): Hexpubkey | undefined {
        const pubkey = event.pubkey;

        if (!pubkey) {
            logger.debug("[TRUST_PUBKEY] Event has no pubkey", {
                eventId: event.id?.substring(0, 12),
            });
            return undefined;
        }

        return pubkey;
    }

    /**
     * Check if pubkey is in the whitelist
     */
    private isWhitelisted(pubkey: Hexpubkey): boolean {
        const whitelisted = this.getWhitelistedPubkeys();
        return whitelisted.includes(pubkey);
    }

    /**
     * Get whitelisted pubkeys from config
     */
    private getWhitelistedPubkeys(): string[] {
        try {
            return config.getWhitelistedPubkeys(undefined, config.getConfig());
        } catch (error) {
            logger.debug("[TRUST_PUBKEY] Failed to get whitelisted pubkeys from config", {
                error: error instanceof Error ? error.message : String(error),
            });
            return [];
        }
    }

    /**
     * Get backend pubkey, using cache if available.
     * This method ensures we only fetch from config.getBackendSigner() once,
     * then use the cached value for subsequent calls.
     *
     * @returns The backend pubkey or undefined if not available
     */
    private async getBackendPubkey(): Promise<Hexpubkey | undefined> {
        // Return cached value if available
        if (this.cachedBackendPubkey) {
            return this.cachedBackendPubkey;
        }

        // Fetch and cache
        try {
            const signer = await config.getBackendSigner();
            this.cachedBackendPubkey = signer.pubkey;
            return this.cachedBackendPubkey;
        } catch (error) {
            logger.debug("[TRUST_PUBKEY] Failed to get backend signer", {
                error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
        }
    }

    /**
     * Check if pubkey belongs to an agent in the system.
     * Returns false if no project context is available (e.g., during daemon startup
     * or when called outside of projectContextStore.run()).
     */
    private isAgentPubkey(pubkey: Hexpubkey): boolean {
        const projectCtx = projectContextStore.getContext();
        if (!projectCtx) {
            return false;
        }
        return projectCtx.getAgentByPubkey(pubkey) !== undefined;
    }

    /**
     * Clear the backend pubkey cache (useful for testing)
     */
    clearCache(): void {
        this.cachedBackendPubkey = undefined;
        logger.debug("[TRUST_PUBKEY] Cache cleared");
    }
}

/**
 * Get the TrustPubkeyService singleton instance
 */
export const getTrustPubkeyService = (): TrustPubkeyService =>
    TrustPubkeyService.getInstance();
