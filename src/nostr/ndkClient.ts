import { getRelayUrls } from "@/utils/relays";
/**
 * TENEX CLI: NDK Singleton
 * Manages a single NDK instance for the CLI
 */
import NDK from "@nostr-dev-kit/ndk";

let ndk: NDK | undefined;

export async function initNDK(): Promise<void> {
    if (ndk) {
        // Disconnect existing instance
        if (ndk.pool?.relays) {
            for (const relay of ndk.pool.relays.values()) {
                relay.disconnect();
            }
        }
    }

    const relays = getRelayUrls();

    ndk = new NDK({
        explicitRelayUrls: [...relays],
        enableOutboxModel: false,
        autoConnectUserRelays: true,
    });

    await ndk.connect();
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
