import * as crypto from "node:crypto";
import { getNDK } from "@/nostr/ndkClient";
import { getRelayUrls } from "@/nostr/relays";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import {
    type NDKEvent,
    NDKNip46Signer,
    NDKPrivateKeySigner,
} from "@nostr-dev-kit/ndk";
import { Nip46SigningLog } from "./Nip46SigningLog";

/**
 * Default configuration values for NIP-46 signing.
 */
const DEFAULTS = {
    SIGNING_TIMEOUT_MS: 30_000,
    CONNECT_TIMEOUT_MS: 30_000,
    MAX_RETRIES: 2,
    FALLBACK_TO_BACKEND: true,
} as const;

/**
 * Result of a NIP-46 signing attempt.
 *
 * - `signed` — signing succeeded
 * - `user_rejected` — user/bunker explicitly rejected; caller should NOT fall back
 * - `failed` — timeout/network error; fallback is appropriate
 */
export type SignResult =
    | { outcome: "signed" }
    | { outcome: "user_rejected"; reason: string }
    | { outcome: "failed"; reason: string };

/**
 * Race a promise against a timeout, cleaning up the timer regardless of outcome.
 * Prevents leaked timers that cause unhandled promise rejections.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Singleton service that manages NIP-46 remote signing for kind 14199 events.
 *
 * Responsibilities:
 * - Lazy initialization of NDKNip46Signer per owner pubkey
 * - Timeout-wrapped signing with configurable retries
 * - Per-owner mutex to serialize signing requests
 * - Graceful fallback to backend signing when NIP-46 is unavailable
 */
export class Nip46SigningService {
    private static instance: Nip46SigningService | null = null;

    /** One NIP-46 signer per owner pubkey */
    private signers = new Map<string, NDKNip46Signer>();

    /** Per-owner promise chain for serialized signing */
    private ownerLocks = new Map<string, Promise<void>>();

    /** Track connection state per owner */
    private connectedOwners = new Set<string>();

    private signingLog: Nip46SigningLog;

    private constructor() {
        this.signingLog = Nip46SigningLog.getInstance();
    }

    static getInstance(): Nip46SigningService {
        if (!Nip46SigningService.instance) {
            Nip46SigningService.instance = new Nip46SigningService();
        }
        return Nip46SigningService.instance;
    }

    // =====================================================================================
    // CONFIGURATION HELPERS
    // =====================================================================================

    /**
     * Check if NIP-46 signing is globally enabled.
     */
    isEnabled(): boolean {
        try {
            const cfg = config.getConfig();
            return cfg.nip46?.enabled === true;
        } catch {
            return false;
        }
    }

    /**
     * Check if NIP-46 is enabled and configured for a specific owner.
     */
    isEnabledForOwner(_ownerPubkey: string): boolean {
        if (!this.isEnabled()) return false;
        // NIP-46 is enabled for all whitelisted owners;
        // we auto-construct bunker URIs when not explicitly configured
        return true;
    }

    /**
     * Get the bunker URI for an owner. If not explicitly configured,
     * auto-constructs: bunker://<ownerPubkey>?relay=<firstRelay>
     */
    getBunkerUri(ownerPubkey: string): string {
        const cfg = config.getConfig();
        const ownerConfig = cfg.nip46?.owners?.[ownerPubkey];

        if (ownerConfig?.bunkerUri) {
            return ownerConfig.bunkerUri;
        }

        // Auto-construct bunker URI
        const relays = getRelayUrls();
        const relay = relays[0] || "wss://tenex.chat";
        return `bunker://${ownerPubkey}?relay=${encodeURIComponent(relay)}`;
    }

    private getSigningTimeout(): number {
        try {
            return config.getConfig().nip46?.signingTimeoutMs ?? DEFAULTS.SIGNING_TIMEOUT_MS;
        } catch {
            return DEFAULTS.SIGNING_TIMEOUT_MS;
        }
    }

    private getMaxRetries(): number {
        try {
            return config.getConfig().nip46?.maxRetries ?? DEFAULTS.MAX_RETRIES;
        } catch {
            return DEFAULTS.MAX_RETRIES;
        }
    }

    shouldFallbackToBackend(): boolean {
        try {
            return config.getConfig().nip46?.fallbackToBackendSigning ?? DEFAULTS.FALLBACK_TO_BACKEND;
        } catch {
            return DEFAULTS.FALLBACK_TO_BACKEND;
        }
    }

    // =====================================================================================
    // SIGNER MANAGEMENT
    // =====================================================================================

    /**
     * Get or create an NDKNip46Signer for a specific owner.
     * Lazy initialization — signer created on first request, not at daemon startup.
     */
    private async getOrCreateSigner(ownerPubkey: string): Promise<NDKNip46Signer> {
        const existing = this.signers.get(ownerPubkey);
        if (existing) return existing;

        const ndk = getNDK();
        const backendNsec = await config.ensureBackendPrivateKey();
        const localSigner = new NDKPrivateKeySigner(backendNsec);
        const bunkerUri = this.getBunkerUri(ownerPubkey);

        logger.info("[NIP-46] Creating signer for owner", {
            ownerPubkey: ownerPubkey.substring(0, 12),
            bunkerUri: bunkerUri.substring(0, 60),
        });

        const signer = NDKNip46Signer.bunker(ndk, bunkerUri, localSigner);

        // Handle auth URL — log it so operator can approve if needed
        signer.on("authUrl", (url: string) => {
            logger.info("[NIP-46] Auth URL required", {
                ownerPubkey: ownerPubkey.substring(0, 12),
                url,
            });
            this.signingLog.log({
                op: "signer_connect",
                ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                error: `auth_url_required: ${url}`,
            });
        });

        this.signers.set(ownerPubkey, signer);
        return signer;
    }

    /**
     * Ensure the signer for an owner is connected (blockUntilReady).
     * Wrapped with timeout to prevent hanging forever.
     */
    private async ensureConnected(ownerPubkey: string): Promise<NDKNip46Signer> {
        const signer = await this.getOrCreateSigner(ownerPubkey);

        if (this.connectedOwners.has(ownerPubkey)) {
            return signer;
        }

        const startMs = Date.now();
        const requestId = crypto.randomUUID().substring(0, 8);

        this.signingLog.log({
            op: "signer_connect",
            requestId,
            ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
        });

        try {
            await withTimeout(
                signer.blockUntilReady(),
                DEFAULTS.CONNECT_TIMEOUT_MS,
                "NIP-46 connect timed out",
            );

            this.connectedOwners.add(ownerPubkey);
            const durationMs = Date.now() - startMs;

            logger.info("[NIP-46] Signer connected", {
                ownerPubkey: ownerPubkey.substring(0, 12),
                durationMs,
            });

            this.signingLog.log({
                op: "signer_connect",
                requestId,
                ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                durationMs,
            });

            return signer;
        } catch (error) {
            const durationMs = Date.now() - startMs;
            const errorMsg = error instanceof Error ? error.message : String(error);

            logger.error("[NIP-46] Signer connection failed", {
                ownerPubkey: ownerPubkey.substring(0, 12),
                error: errorMsg,
                durationMs,
            });

            this.signingLog.log({
                op: "sign_error",
                requestId,
                ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                error: `connect_failed: ${errorMsg}`,
                durationMs,
            });

            // Remove from cache so next attempt creates a fresh signer
            this.signers.delete(ownerPubkey);
            throw error;
        }
    }

    // =====================================================================================
    // PER-OWNER MUTEX
    // =====================================================================================

    /**
     * Serialize operations per owner pubkey to avoid concurrent NIP-46 signing.
     */
    private async withOwnerLock<T>(ownerPubkey: string, fn: () => Promise<T>): Promise<T> {
        const existing = this.ownerLocks.get(ownerPubkey) ?? Promise.resolve();
        let resolve: () => void;
        const next = new Promise<void>((r) => (resolve = r));
        this.ownerLocks.set(ownerPubkey, next);

        await existing;

        try {
            return await fn();
        } finally {
            resolve!();
            if (this.ownerLocks.get(ownerPubkey) === next) {
                this.ownerLocks.delete(ownerPubkey);
            }
        }
    }

    // =====================================================================================
    // SIGNING
    // =====================================================================================

    /**
     * Sign an NDKEvent using NIP-46 remote signing for the given owner.
     *
     * @param ownerPubkey - The owner's hex pubkey (the "user" in NIP-46 terms)
     * @param event - The NDKEvent to sign (will be mutated: pubkey set to ownerPubkey)
     * @returns SignResult indicating success, explicit rejection, or transient failure
     */
    async signEvent(ownerPubkey: string, event: NDKEvent): Promise<SignResult> {
        return this.withOwnerLock(ownerPubkey, () =>
            this.signEventInternal(ownerPubkey, event)
        );
    }

    private async signEventInternal(ownerPubkey: string, event: NDKEvent): Promise<SignResult> {
        const requestId = crypto.randomUUID().substring(0, 8);
        const signingTimeout = this.getSigningTimeout();
        const maxRetries = this.getMaxRetries();
        const startMs = Date.now();

        this.signingLog.log({
            op: "sign_request",
            requestId,
            ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
            eventKind: event.kind,
            pTagCount: event.tags.filter((t) => t[0] === "p").length,
        });

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const signer = await this.ensureConnected(ownerPubkey);

                // Set the event pubkey to the owner before signing
                event.pubkey = ownerPubkey;

                await withTimeout(
                    event.sign(signer),
                    signingTimeout,
                    "NIP-46 sign timed out",
                );

                const durationMs = Date.now() - startMs;

                this.signingLog.log({
                    op: "sign_success",
                    requestId,
                    ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                    eventKind: event.kind,
                    signerType: "nip46",
                    durationMs,
                    eventId: event.id,
                });

                logger.info("[NIP-46] Event signed successfully", {
                    ownerPubkey: ownerPubkey.substring(0, 12),
                    eventKind: event.kind,
                    eventId: event.id?.substring(0, 12),
                    durationMs,
                    attempt,
                });

                return { outcome: "signed" };
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                const errorMsg = lastError.message;

                // User rejection — never retry
                if (this.isUserRejection(errorMsg)) {
                    const durationMs = Date.now() - startMs;

                    this.signingLog.log({
                        op: "sign_rejected",
                        requestId,
                        ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                        eventKind: event.kind,
                        error: errorMsg,
                        durationMs,
                    });

                    logger.warn("[NIP-46] Signing rejected by user", {
                        ownerPubkey: ownerPubkey.substring(0, 12),
                        eventKind: event.kind,
                        error: errorMsg,
                    });

                    return { outcome: "user_rejected", reason: errorMsg };
                }

                // Timeout or relay error — retry if attempts remain
                if (attempt < maxRetries) {
                    logger.warn("[NIP-46] Signing failed, retrying", {
                        ownerPubkey: ownerPubkey.substring(0, 12),
                        eventKind: event.kind,
                        attempt: attempt + 1,
                        maxRetries,
                        error: errorMsg,
                    });

                    // Reset signer on connection errors
                    if (errorMsg.includes("connect") || errorMsg.includes("timed out")) {
                        this.signers.delete(ownerPubkey);
                        this.connectedOwners.delete(ownerPubkey);
                    }

                    continue;
                }
            }
        }

        // All retries exhausted
        const durationMs = Date.now() - startMs;
        const errorMsg = lastError?.message ?? "unknown error";

        if (errorMsg.includes("timed out")) {
            this.signingLog.log({
                op: "sign_timeout",
                requestId,
                ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                eventKind: event.kind,
                error: errorMsg,
                durationMs,
            });
        } else {
            this.signingLog.log({
                op: "sign_error",
                requestId,
                ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                eventKind: event.kind,
                error: errorMsg,
                durationMs,
            });
        }

        logger.error("[NIP-46] Signing failed after all retries", {
            ownerPubkey: ownerPubkey.substring(0, 12),
            eventKind: event.kind,
            retries: maxRetries,
            error: errorMsg,
            durationMs,
        });

        return { outcome: "failed", reason: errorMsg };
    }

    /**
     * Detect user rejection errors — these should never be retried.
     */
    private isUserRejection(errorMsg: string): boolean {
        const rejectionPatterns = [
            "rejected",
            "denied",
            "refused",
            "not authorized",
            "user declined",
        ];
        const lower = errorMsg.toLowerCase();
        return rejectionPatterns.some((p) => lower.includes(p));
    }

    // =====================================================================================
    // LIFECYCLE
    // =====================================================================================

    /**
     * Clean up all NIP-46 signer connections.
     */
    async shutdown(): Promise<void> {
        logger.info("[NIP-46] Shutting down signing service", {
            activeSingers: this.signers.size,
        });

        this.signers.clear();
        this.connectedOwners.clear();
        this.ownerLocks.clear();
    }
}
