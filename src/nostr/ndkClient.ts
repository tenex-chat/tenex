import { getRelayUrls } from "./relays";
import { logger } from "@/utils/logger";
/**
 * TENEX CLI: NDK Singleton
 * Manages a single NDK instance for the CLI
 */
import NDK, { NDKRelayAuthPolicies } from "@nostr-dev-kit/ndk";

let ndk: NDK | undefined;

/**
 * Initialize NDK with timeout for relay connections
 * Proceeds even if relay connection fails (daemon can still function locally)
 */
export async function initNDK(): Promise<void> {
    // If already initialized, don't reinitialize
    if (ndk) {
        logger.debug("NDK already initialized, skipping");
        return;
    }

    const relays = getRelayUrls();
    logger.debug(`Initializing NDK with relays: ${relays.join(", ")}`);

    ndk = new NDK({
        explicitRelayUrls: [...relays],
        enableOutboxModel: false,
        autoConnectUserRelays: true,
    });

    // Auto-authenticate with relays that require NIP-42 auth
    ndk.relayAuthDefaultPolicy = NDKRelayAuthPolicies.signIn({ ndk });

    // Listen for relay connection events
    ndk.pool?.on("relay:connect", (relay) => {
        logger.info("Relay connected", { url: relay.url });
    });

    ndk.pool?.on("relay:disconnect", (relay) => {
        logger.warn("Relay disconnected", { url: relay.url });
    });

    // Connect with timeout - don't block daemon startup if relays are unreachable
    const connectionTimeout = 5000; // 5 seconds
    try {
        await Promise.race([
            ndk.connect(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Connection timeout")), connectionTimeout)
            ),
        ]);
        logger.debug("NDK connected to relays");
    } catch (error) {
        logger.warn(`NDK relay connection failed or timed out after ${connectionTimeout}ms - continuing without Nostr connectivity`, {
            error: error instanceof Error ? error.message : String(error),
            relays,
        });
        // Don't throw - daemon can still function locally without Nostr
    }
}

export function getNDK(): NDK {
    if (!ndk) {
        throw new Error(
            "NDK not initialized. Please call initNDK() first or check your network configuration."
        );
    }
    return ndk;
}

export async function shutdownNDK(): Promise<void> {
    if (ndk) {
        // Disconnect all relays
        if (ndk.pool?.relays) {
            for (const relay of ndk.pool.relays.values()) {
                relay.disconnect();
            }
        }
        ndk = undefined;
    }
}
