import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";
import { shortenOptionalEventId, shortenPubkey } from "@/utils/conversation-id";

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
 * Optional project-scoped trust inputs for the current check.
 * This keeps project agent trust explicit instead of reaching into ambient context.
 */
export interface TrustCheckContext {
    /** Agent pubkeys scoped to the current project or execution context. */
    projectAgentPubkeys?: Iterable<Hexpubkey>;
}

/**
 * TrustPubkeyService determines if a given pubkey should be heeded or ignored.
 *
 * A pubkey is trusted if it is:
 * - In the whitelisted pubkeys from config
 * - The backend's own pubkey
 * - An agent in the system (provided explicitly for the current project or globally across all projects)
 *
 * Trust precedence (highest to lowest): whitelisted > backend > agent
 *
 * ## Agent Trust: Two-Tier Lookup + Daemon Seeding
 * 1. **Project-scoped agent set** (sync): Check the caller-provided agent registry (fast, scoped)
 * 2. **Global agent set** (sync): Check daemon-level set of all agent pubkeys across all projects
 *
 * The global agent set is seeded by the Daemon at startup from AgentStorage (covering
 * not-yet-running projects) and kept in sync as projects start/stop. Each sync unions
 * the active runtime pubkeys with the stored seed, so trust is never dropped.
 */
export class TrustPubkeyService {
    private static instance: TrustPubkeyService;

    /** Cached backend pubkey to avoid repeated async calls */
    private cachedBackendPubkey?: Hexpubkey;

    /** Cached whitelist Set for O(1) lookups */
    private cachedWhitelistSet?: Set<Hexpubkey>;

    /**
     * Global set of agent pubkeys across ALL projects (running and discovered).
     * Pushed by the Daemon whenever projects start/stop or agents are added.
     * Frozen for safe concurrent reads.
     */
    private globalAgentPubkeys: ReadonlySet<Hexpubkey> = Object.freeze(new Set<Hexpubkey>());

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
    async isTrusted(pubkey: Hexpubkey, context?: TrustCheckContext): Promise<TrustResult> {
        // 1. Check whitelisted pubkeys from config
        if (this.isWhitelisted(pubkey)) {
            logger.debug("[TRUST_PUBKEY] Pubkey trusted: whitelisted", {
                pubkey: shortenPubkey(pubkey),
            });
            return { trusted: true, reason: "whitelisted" };
        }

        // 2. Check if it's the backend's own pubkey (uses cache)
        const backendPubkey = await this.getBackendPubkey();
        if (backendPubkey && pubkey === backendPubkey) {
            logger.debug("[TRUST_PUBKEY] Pubkey trusted: backend", {
                pubkey: shortenPubkey(pubkey),
            });
            return { trusted: true, reason: "backend" };
        }

        // 3. Check if it's an agent in the system
        if (this.isAgentPubkey(pubkey, context)) {
            logger.debug("[TRUST_PUBKEY] Pubkey trusted: agent", {
                pubkey: shortenPubkey(pubkey),
            });
            return { trusted: true, reason: "agent" };
        }

        // Not trusted
        logger.debug("[TRUST_PUBKEY] Pubkey not trusted", {
            pubkey: shortenPubkey(pubkey),
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
    async isTrustedEvent(event: NDKEvent, context?: TrustCheckContext): Promise<TrustResult> {
        const pubkey = this.getEventPubkey(event);

        if (!pubkey) {
            return { trusted: false };
        }

        return this.isTrusted(pubkey, context);
    }

    /**
     * Synchronous version of isTrustedEvent - uses cached backend pubkey.
     * Note: May return false negative for backend pubkey if cache is not initialized.
     * Use initializeBackendPubkeyCache() first if you need sync checks.
     *
     * @param event The NDKEvent to check
     * @returns TrustResult indicating if the event's author is trusted and why
     */
    isTrustedEventSync(event: NDKEvent, context?: TrustCheckContext): TrustResult {
        const pubkey = this.getEventPubkey(event);

        if (!pubkey) {
            return { trusted: false };
        }

        return this.isTrustedSync(pubkey, context);
    }

    /**
     * Synchronous version of isTrusted - uses cached backend pubkey.
     * Note: May return false negative for backend pubkey if cache is not initialized.
     * Use initializeBackendPubkeyCache() first if you need sync checks.
     *
     * @param pubkey The pubkey to check (hex format)
     * @returns TrustResult indicating if trusted and why
     */
    isTrustedSync(pubkey: Hexpubkey, context?: TrustCheckContext): TrustResult {
        // 1. Check whitelisted pubkeys from config
        if (this.isWhitelisted(pubkey)) {
            return { trusted: true, reason: "whitelisted" };
        }

        // 2. Check cached backend pubkey
        if (this.cachedBackendPubkey && pubkey === this.cachedBackendPubkey) {
            return { trusted: true, reason: "backend" };
        }

        // 3. Check if it's an agent in the system
        if (this.isAgentPubkey(pubkey, context)) {
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
                pubkey: shortenPubkey(pubkey),
            });
        }
        // Note: getBackendPubkey already logs debug message on failure
    }

    /**
     * Set the global agent pubkeys set (daemon-level, cross-project).
     * Called by the Daemon when projects start/stop or agents are dynamically added.
     * The set is frozen for safe concurrent reads.
     *
     * @param pubkeys Set of all known agent pubkeys across all projects
     */
    setGlobalAgentPubkeys(pubkeys: Set<Hexpubkey>): void {
        this.globalAgentPubkeys = Object.freeze(new Set(pubkeys));
        logger.debug("[TRUST_PUBKEY] Global agent pubkeys updated", {
            count: pubkeys.size,
        });
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
    async getAllTrustedPubkeys(
        context?: TrustCheckContext
    ): Promise<Array<{ pubkey: Hexpubkey; reason: TrustReason }>> {
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
        // 3a. Caller-provided project-scoped agent pubkeys
        for (const pubkey of context?.projectAgentPubkeys ?? []) {
            if (!trustedMap.has(pubkey)) {
                trustedMap.set(pubkey, "agent");
            }
        }

        // 3b. Global agent pubkeys (cross-project)
        for (const pubkey of this.globalAgentPubkeys) {
            if (!trustedMap.has(pubkey)) {
                trustedMap.set(pubkey, "agent");
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
                eventId: shortenOptionalEventId(event.id),
            });
            return undefined;
        }

        return pubkey;
    }

    /**
     * Check if pubkey is in the whitelist using cached Set for O(1) lookups.
     */
    private isWhitelisted(pubkey: Hexpubkey): boolean {
        return this.getWhitelistSet().has(pubkey);
    }

    /**
     * Get the cached whitelist Set, building from config on first access.
     * The set is cached until clearCache() is called; config changes
     * are only reflected after an explicit cache clear.
     */
    private getWhitelistSet(): Set<Hexpubkey> {
        if (!this.cachedWhitelistSet) {
            this.cachedWhitelistSet = new Set(this.getWhitelistedPubkeys());
        }
        return this.cachedWhitelistSet;
    }

    /**
     * Get whitelisted pubkeys from config
     */
    private getWhitelistedPubkeys(): string[] {
        try {
            return config.getWhitelistedPubkeys();
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
     * Check if pubkey belongs to an agent in the system (synchronous, two-tier).
     *
     * Tier 1: Caller-provided project-scoped agent pubkeys
     * Tier 2: Global agent pubkeys set (daemon-level, covers all projects including non-running)
     *
     * The global set is maintained by the Daemon via setGlobalAgentPubkeys(),
     * which unions active runtime pubkeys with the AgentStorage seed.
     */
    private isAgentPubkey(pubkey: Hexpubkey, context?: TrustCheckContext): boolean {
        // Tier 1: Caller-provided project-scoped agent pubkeys
        for (const candidate of context?.projectAgentPubkeys ?? []) {
            if (candidate === pubkey) {
                return true;
            }
        }

        // Tier 2: Global agent pubkeys (daemon-level, cross-project)
        if (this.globalAgentPubkeys.has(pubkey)) {
            return true;
        }

        return false;
    }

    /**
     * Clear config-derived caches (useful for testing and config reloads).
     * Does NOT clear globalAgentPubkeys — that state is managed by the Daemon
     * via setGlobalAgentPubkeys() and is not derived from config.
     */
    clearCache(): void {
        this.cachedBackendPubkey = undefined;
        this.cachedWhitelistSet = undefined;
        logger.debug("[TRUST_PUBKEY] Config cache cleared");
    }

    /**
     * Reset all state including daemon-managed global agent pubkeys.
     * Use only in tests to fully reset the service.
     */
    resetAll(): void {
        this.cachedBackendPubkey = undefined;
        this.cachedWhitelistSet = undefined;
        this.globalAgentPubkeys = Object.freeze(new Set<Hexpubkey>());
        logger.debug("[TRUST_PUBKEY] Full state reset");
    }
}

/**
 * Get the TrustPubkeyService singleton instance
 */
export const getTrustPubkeyService = (): TrustPubkeyService =>
    TrustPubkeyService.getInstance();
