import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { Nip46SigningService, Nip46SigningLog } from "@/services/nip46";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKPrivateKeySigner, type NDKSubscription } from "@nostr-dev-kit/ndk";

const DEBOUNCE_MS = 5000;

/**
 * Global singleton that owns the in-memory truth of each owner's kind:14199 p-tags.
 *
 * Projects call `registerAgents(projectDTag, pubkeys)` — the service handles
 * deduplication, debouncing, and publishing. Per-project tracking enables
 * `unregisterAgent` to remove pubkeys only when no project references them.
 *
 * Pending additions survive relay echo events to prevent the race condition
 * where a relay event clobbers locally-queued-but-not-yet-published pubkeys.
 *
 * Follows the same singleton + subscription pattern as NudgeSkillWhitelistService.
 */
export class OwnerAgentListService {
    private static instance: OwnerAgentListService;

    /** Owner pubkeys to manage (from config) */
    private ownerPubkeys: string[] = [];

    /** Per-owner in-memory set of agent pubkeys — source of truth */
    private ownerAgentSets: Map<string, Set<string>> = new Map();

    /** Locally-added pubkeys not yet confirmed by relay echo — survives handleIncomingEvent */
    private pendingAdditions: Set<string> = new Set();

    /** Per-agent tracking: agentPubkey → set of projectDTags that contributed it */
    private agentProjectSources: Map<string, Set<string>> = new Map();

    /** Per-owner latest 14199 event from subscription (replaceable semantics) */
    private latestEvents: Map<string, NDKEvent> = new Map();

    /** Owners needing a publish */
    private pendingOwners: Set<string> = new Set();

    /** Debounce timer for coalescing rapid registerAgents calls */
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    /** Always-on subscription for kind:14199 */
    private subscription: NDKSubscription | null = null;

    private initialized = false;

    private constructor() {}

    static getInstance(): OwnerAgentListService {
        if (!OwnerAgentListService.instance) {
            OwnerAgentListService.instance = new OwnerAgentListService();
        }
        return OwnerAgentListService.instance;
    }

    /**
     * Initialize with owner pubkeys and start relay subscription.
     * Returns immediately — relay replay populates initial state.
     */
    initialize(ownerPubkeys: string[]): void {
        if (this.initialized) {
            logger.debug("[OwnerAgentListService] Already initialized, skipping");
            return;
        }

        this.ownerPubkeys = ownerPubkeys;
        for (const pk of ownerPubkeys) {
            this.ownerAgentSets.set(pk, new Set());
        }
        this.initialized = true;

        this.startSubscription();

        logger.info("[OwnerAgentListService] Initialized", {
            ownerCount: ownerPubkeys.length,
        });
    }

    /**
     * Register agent pubkeys into all owners' 14199 lists.
     * Tracks per-project contributions so removal is possible via unregisterAgent.
     * Debounces publish to coalesce rapid calls.
     */
    registerAgents(projectDTag: string, agentPubkeys: string[]): void {
        if (!this.initialized) {
            logger.warn("[OwnerAgentListService] Not initialized, ignoring registerAgents call");
            return;
        }

        let anyNew = false;

        for (const pk of agentPubkeys) {
            // Track project source
            let sources = this.agentProjectSources.get(pk);
            if (!sources) {
                sources = new Set();
                this.agentProjectSources.set(pk, sources);
            }
            sources.add(projectDTag);

            for (const owner of this.ownerPubkeys) {
                const set = this.ownerAgentSets.get(owner);
                if (!set) continue;

                if (!set.has(pk)) {
                    set.add(pk);
                    anyNew = true;
                    this.pendingOwners.add(owner);
                }
            }

            // Track as pending until relay echo confirms
            this.pendingAdditions.add(pk);
        }

        if (!anyNew) {
            logger.debug("[OwnerAgentListService] All agent pubkeys already registered, skipping");
            return;
        }

        this.resetDebounce();
    }

    /**
     * Unregister an agent from a specific project.
     * Only removes the pubkey from 14199 when no other projects reference it.
     */
    unregisterAgent(projectDTag: string, agentPubkey: string): void {
        if (!this.initialized) {
            logger.warn("[OwnerAgentListService] Not initialized, ignoring unregisterAgent call");
            return;
        }

        const sources = this.agentProjectSources.get(agentPubkey);
        if (!sources) return;

        sources.delete(projectDTag);

        if (sources.size > 0) return;

        // No projects reference this agent — remove everywhere
        this.agentProjectSources.delete(agentPubkey);
        this.pendingAdditions.delete(agentPubkey);

        for (const owner of this.ownerPubkeys) {
            const set = this.ownerAgentSets.get(owner);
            if (!set) continue;

            if (set.delete(agentPubkey)) {
                this.pendingOwners.add(owner);
            }
        }

        if (this.pendingOwners.size > 0) {
            this.resetDebounce();
        }
    }

    /**
     * Stop subscription, clear debounce timer, clear all state.
     */
    shutdown(): void {
        if (this.subscription) {
            this.subscription.stop();
            this.subscription = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.ownerAgentSets.clear();
        this.pendingAdditions.clear();
        this.agentProjectSources.clear();
        this.latestEvents.clear();
        this.pendingOwners.clear();
        this.ownerPubkeys = [];
        this.initialized = false;
    }

    private startSubscription(): void {
        if (this.ownerPubkeys.length === 0) {
            logger.debug("[OwnerAgentListService] No owner pubkeys, skipping subscription");
            return;
        }

        const ndk = getNDK();

        this.subscription = ndk.subscribe(
            {
                kinds: [NDKKind.ProjectAgentSnapshot as number],
                authors: this.ownerPubkeys,
            },
            {
                closeOnEose: false,
                onEvent: (event: NDKEvent) => {
                    this.handleIncomingEvent(event);
                },
            },
        );

        logger.debug("[OwnerAgentListService] Started 14199 subscription", {
            ownerCount: this.ownerPubkeys.length,
        });
    }

    /**
     * Handle incoming 14199 event from relay.
     * Replaceable semantics: only process if newer than stored event.
     * Replaces in-memory set with relay state to stay in sync.
     */
    private handleIncomingEvent(event: NDKEvent): void {
        const existing = this.latestEvents.get(event.pubkey);
        if (
            existing &&
            existing.created_at !== undefined &&
            event.created_at !== undefined &&
            existing.created_at >= event.created_at
        ) {
            return;
        }

        this.latestEvents.set(event.pubkey, event);

        // Merge relay state with locally-pending additions to avoid clobbering
        const ptagPubkeys = event.tags
            .filter((t) => t[0] === "p" && t[1])
            .map((t) => t[1]);

        const merged = new Set(ptagPubkeys);
        for (const pk of this.pendingAdditions) {
            merged.add(pk);
        }
        this.ownerAgentSets.set(event.pubkey, merged);

        logger.debug("[OwnerAgentListService] Updated from relay event", {
            ownerPubkey: event.pubkey.substring(0, 12),
            pTagCount: ptagPubkeys.length,
            pendingCount: this.pendingAdditions.size,
        });
    }

    private resetDebounce(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.publishPendingUpdates().catch((error) => {
                logger.warn("[OwnerAgentListService] Debounced publish failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }, DEBOUNCE_MS);
    }

    /**
     * Publish 14199 events for all pending owners.
     */
    private async publishPendingUpdates(): Promise<void> {
        const owners = Array.from(this.pendingOwners);
        this.pendingOwners.clear();
        this.pendingAdditions.clear();

        if (owners.length === 0) return;

        const nip46Service = Nip46SigningService.getInstance();
        const useNip46 = nip46Service.isEnabled();

        for (const owner of owners) {
            const agentPubkeys = this.ownerAgentSets.get(owner);
            if (!agentPubkeys) continue;

            const allPubkeys = Array.from(agentPubkeys);
            const ndk = getNDK();
            const ev = new NDKEvent(ndk, {
                kind: NDKKind.ProjectAgentSnapshot,
            });

            for (const pk of allPubkeys) {
                ev.tag(["p", pk]);
            }

            if (useNip46) {
                await this.publishWithNip46(owner, ev, allPubkeys.length, nip46Service);
            } else {
                await this.publishWithBackendKey(ev, allPubkeys.length);
            }
        }
    }

    private async publishWithNip46(
        ownerPubkey: string,
        ev: NDKEvent,
        pTagCount: number,
        nip46Service: Nip46SigningService,
    ): Promise<void> {
        const signingLog = Nip46SigningLog.getInstance();
        const result = await nip46Service.signEvent(ownerPubkey, ev, "14199_snapshot");

        if (result.outcome === "signed") {
            try {
                await ev.publish();
                signingLog.log({
                    op: "event_published",
                    ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                    eventKind: NDKKind.ProjectAgentSnapshot as number,
                    signerType: "nip46",
                    pTagCount,
                    eventId: ev.id,
                });
                logger.info("[OwnerAgentListService] Published owner-signed 14199", {
                    ownerPubkey: ownerPubkey.substring(0, 12),
                    eventId: ev.id?.substring(0, 12),
                    pTagCount,
                });
            } catch (error) {
                logger.warn("[OwnerAgentListService] Failed to publish owner-signed 14199", {
                    ownerPubkey: ownerPubkey.substring(0, 12),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        logger.warn("[OwnerAgentListService] Skipping 14199 publish — signing failed", {
            ownerPubkey: ownerPubkey.substring(0, 12),
            outcome: result.outcome,
            reason: "reason" in result ? result.reason : undefined,
        });
    }

    private async publishWithBackendKey(ev: NDKEvent, pTagCount: number): Promise<void> {
        const tenexNsec = await config.ensureBackendPrivateKey();
        const signer = new NDKPrivateKeySigner(tenexNsec);

        await ev.sign(signer);
        try {
            await ev.publish();
            logger.info("[OwnerAgentListService] Published backend-signed 14199", {
                pTagCount,
            });
        } catch (error) {
            logger.warn("[OwnerAgentListService] Failed to publish backend-signed 14199", {
                error: error instanceof Error ? error.message : String(error),
                eventId: ev.id?.substring(0, 12),
            });
        }
    }
}
