import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent, NDKFilter, NDKSubscriptionOptions } from "@nostr-dev-kit/ndk";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface CollectEventsOptions {
    /** Additional subscription options (closeOnEose is always forced true). */
    subOpts?: Omit<NDKSubscriptionOptions, "closeOnEose">;
    /** Timeout in milliseconds. Defaults to 15 000. Set to 0 to disable. */
    timeoutMs?: number;
}

/**
 * Subscribe to a filter and collect all events until EOSE, with timeout
 * protection and deduplication by event id.
 *
 * Resolves with the collected (deduplicated) events once EOSE is received
 * or the timeout fires — whichever comes first.  If the relay closes the
 * connection before EOSE, the partial set is returned and a warning is logged.
 */
export function collectEvents(
    ndk: NDK,
    filter: NDKFilter,
    options: CollectEventsOptions = {},
): Promise<NDKEvent[]> {
    const { subOpts = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const seen = new Map<string, NDKEvent>();

    return new Promise<NDKEvent[]>((resolve) => {
        let settled = false;
        let eoseReceived = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(Array.from(seen.values()));
        };

        const sub = ndk.subscribe(
            filter,
            { ...subOpts, closeOnEose: true },
            {
                onEvent: (event) => {
                    try {
                        seen.set(event.id, event);
                    } catch (err) {
                        logger.warn("collectEvents: error in onEvent", { err });
                    }
                },
                onEose: () => {
                    eoseReceived = true;
                    finish();
                },
                onClose: () => {
                    if (!eoseReceived) {
                        logger.warn("collectEvents: relay closed before EOSE", {
                            filter,
                            collected: seen.size,
                        });
                    }
                    finish();
                },
            },
        );

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                if (!settled) {
                    logger.warn("collectEvents: timed out waiting for EOSE", {
                        timeoutMs,
                        filter,
                        collected: seen.size,
                    });
                    sub.stop();
                    finish();
                }
            }, timeoutMs);
        }
    });
}
