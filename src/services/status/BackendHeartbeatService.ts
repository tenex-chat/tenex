import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { shortenPubkey } from "@/utils/conversation-id";
import { NDKEvent, type NDKSubscription } from "@nostr-dev-kit/ndk";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Publishes ephemeral kind:24012 heartbeat events when the backend's pubkey
 * is missing from the owner's kind:14199 agent snapshot.
 *
 * This solves the bootstrap problem: without being in the 14199, the relay's
 * ACL blocks the backend from reading non-ephemeral events (projects, agent
 * definitions, etc.). The heartbeat is ephemeral (20000-29999 range) so the
 * relay delivers it regardless of whitelist status. The client sees the
 * heartbeat, prompts the user to approve the backend, and publishes an
 * updated 14199 that includes the backend pubkey — unblocking full access.
 *
 * Automatically stops heartbeating once the backend observes itself in a
 * 14199 event from any owner.
 */
export class BackendHeartbeatService {
    private backendPubkey = "";
    private ownerPubkeys: string[] = [];
    private whitelisted = false;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private subscription: NDKSubscription | null = null;

    /**
     * Start monitoring 14199 events and heartbeating if needed.
     */
    start(backendPubkey: string, ownerPubkeys: string[]): void {
        this.backendPubkey = backendPubkey;
        this.ownerPubkeys = ownerPubkeys;

        if (ownerPubkeys.length === 0) {
            logger.debug("[BackendHeartbeat] No owner pubkeys, skipping");
            return;
        }

        this.subscribeToOwnerSnapshots();
    }

    stop(): void {
        this.stopHeartbeat();
        if (this.subscription) {
            this.subscription.stop();
            this.subscription = null;
        }
    }

    private subscribeToOwnerSnapshots(): void {
        const ndk = getNDK();

        this.subscription = ndk.subscribe(
            {
                kinds: [NDKKind.ProjectAgentSnapshot as number],
                authors: this.ownerPubkeys,
            },
            {
                closeOnEose: false,
                onEose: () => this.onEose(),
                onEvent: (event: NDKEvent) => this.handleSnapshotEvent(event),
            },
        );

        logger.debug("[BackendHeartbeat] Subscribed to owner 14199 events", {
            ownerCount: this.ownerPubkeys.length,
            backendPubkey: shortenPubkey(this.backendPubkey),
        });
    }

    /**
     * After replaying stored 14199 events, decide whether to start heartbeating.
     */
    private onEose(): void {
        if (!this.whitelisted) {
            logger.info("[BackendHeartbeat] Backend not found in any owner 14199, starting heartbeat", {
                backendPubkey: shortenPubkey(this.backendPubkey),
            });
            this.startHeartbeat();
        }
    }

    private handleSnapshotEvent(event: NDKEvent): void {
        const pTaggedPubkeys = event.tags
            .filter((t) => t[0] === "p" && t[1])
            .map((t) => t[1]);

        if (pTaggedPubkeys.includes(this.backendPubkey)) {
            this.whitelisted = true;
            this.stopHeartbeat();
            logger.info("[BackendHeartbeat] Backend found in owner 14199, heartbeat stopped", {
                backendPubkey: shortenPubkey(this.backendPubkey),
                owner: shortenPubkey(event.pubkey),
            });
        }
    }

    private startHeartbeat(): void {
        if (this.heartbeatInterval) return;

        // Publish immediately, then on interval
        void this.publishHeartbeat();

        this.heartbeatInterval = setInterval(() => {
            if (this.whitelisted) {
                this.stopHeartbeat();
                return;
            }
            void this.publishHeartbeat();
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    private async publishHeartbeat(): Promise<void> {
        try {
            const backendSigner = await config.getBackendSigner();
            const ndk = getNDK();
            const event = new NDKEvent(ndk);
            event.kind = NDKKind.TenexBackendHeartbeat;
            event.content = "";

            for (const ownerPubkey of this.ownerPubkeys) {
                event.tag(["p", ownerPubkey]);
            }

            await event.sign(backendSigner, { pTags: false });
            await event.publish();

            logger.debug("[BackendHeartbeat] Published heartbeat", {
                backendPubkey: shortenPubkey(this.backendPubkey),
                ownerCount: this.ownerPubkeys.length,
            });
        } catch (error) {
            logger.warn("[BackendHeartbeat] Failed to publish heartbeat", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}
