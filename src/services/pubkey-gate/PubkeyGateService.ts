import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { checkPubkey, WhitelistDaemonError } from "./whitelistDaemonClient";

/**
 * PubkeyGateService gates incoming events based on pubkey authorization.
 *
 * The trust decision is delegated to the standalone `tenex-whitelist` Rust
 * daemon over a Unix socket. The daemon is the single source of truth for
 * "is pubkey X allowed on this machine"; this service is just the call site
 * adapter for incoming Nostr events.
 *
 * Fail-closed: connect errors, timeouts, or malformed responses deny the
 * event. Operators must keep the whitelist daemon running.
 */
const NO_PROJECT_DTAG = "-";

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
     * Returns true if the event should be routed, false if it should be dropped.
     */
    async shouldAllowEvent(event: NDKEvent): Promise<boolean> {
        const pubkey = event.pubkey;

        if (!pubkey) {
            logger.debug("[PUBKEY_GATE] Event denied: missing pubkey", {
                kind: event.kind,
            });
            this.recordDenied(event, "no_pubkey");
            return false;
        }

        try {
            const allowed = await checkPubkey(pubkey, NO_PROJECT_DTAG);
            if (!allowed) {
                logger.debug("[PUBKEY_GATE] Event denied: untrusted pubkey", {
                    pubkey: pubkey.substring(0, 8),
                    kind: event.kind,
                });
                this.recordDenied(event, "untrusted");
                return false;
            }
            return true;
        } catch (error) {
            logger.warn("[PUBKEY_GATE] Whitelist daemon query failed, denying event (fail-closed)", {
                pubkey: pubkey.substring(0, 8),
                kind: event.kind,
                error: error instanceof Error ? error.message : String(error),
                transport: error instanceof WhitelistDaemonError,
            });
            this.recordDenied(event, "error");
            return false;
        }
    }

    private recordDenied(event: NDKEvent, reason: string): void {
        trace.getActiveSpan()?.addEvent("pubkey_gate.denied", {
            "gate.pubkey": event.pubkey ? event.pubkey.substring(0, 8) : "(none)",
            "gate.kind": event.kind ?? 0,
            "gate.reason": reason,
        });
    }
}

export const getPubkeyGateService = (): PubkeyGateService => PubkeyGateService.getInstance();
