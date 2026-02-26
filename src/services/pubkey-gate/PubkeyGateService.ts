import { getTrustPubkeyService, type TrustResult } from "@/services/trust-pubkeys";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * PubkeyGateService gates incoming events based on pubkey authorization.
 *
 * An event is allowed through if its author's pubkey is trusted by TrustPubkeyService
 * (whitelisted, backend, or known agent). All other events are silently dropped.
 *
 * Design principles:
 * - Fail-closed: if the trust check errors, the event is denied
 * - Sanitized logging: only pubkey prefix + event kind for observability
 * - OpenTelemetry telemetry for audit trail
 * - Sync trust checks for performance (requires backend pubkey cache initialization)
 */
export class PubkeyGateService {
    private static instance: PubkeyGateService;

    private constructor() {}

    static getInstance(): PubkeyGateService {
        if (!PubkeyGateService.instance) {
            PubkeyGateService.instance = new PubkeyGateService();
        }
        return PubkeyGateService.instance;
    }

    /**
     * Check if an incoming event should be allowed through the gate.
     *
     * Uses synchronous trust checks for performance. The backend pubkey cache
     * must be initialized via TrustPubkeyService.initializeBackendPubkeyCache()
     * before calling this method for accurate backend pubkey checks.
     *
     * @param event The incoming NDKEvent to check
     * @returns true if the event should be routed, false if it should be dropped
     */
    shouldAllowEvent(event: NDKEvent): boolean {
        const pubkey = event.pubkey;

        if (!pubkey) {
            logger.debug("[PUBKEY_GATE] Event denied: missing pubkey", {
                kind: event.kind,
            });
            this.recordDenied(event, "no_pubkey");
            return false;
        }

        let trustResult: TrustResult;
        try {
            trustResult = getTrustPubkeyService().isTrustedEventSync(event);
        } catch (error) {
            // Fail-closed: if the trust check errors, deny
            logger.warn("[PUBKEY_GATE] Trust check failed, denying event (fail-closed)", {
                pubkey: pubkey.substring(0, 8),
                kind: event.kind,
                error: error instanceof Error ? error.message : String(error),
            });
            this.recordDenied(event, "error");
            return false;
        }

        if (!trustResult.trusted) {
            logger.debug("[PUBKEY_GATE] Event denied: untrusted pubkey", {
                pubkey: pubkey.substring(0, 8),
                kind: event.kind,
            });
            this.recordDenied(event, "untrusted");
            return false;
        }

        return true;
    }

    /**
     * Record a denied event in telemetry for audit trail.
     */
    private recordDenied(event: NDKEvent, reason: string): void {
        trace.getActiveSpan()?.addEvent("pubkey_gate.denied", {
            "gate.pubkey": event.pubkey?.substring(0, 8) ?? "unknown",
            "gate.kind": event.kind ?? 0,
            "gate.reason": reason,
        });
    }
}

/**
 * Get the PubkeyGateService singleton instance
 */
export const getPubkeyGateService = (): PubkeyGateService =>
    PubkeyGateService.getInstance();
