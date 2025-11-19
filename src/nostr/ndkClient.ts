import { config } from "@/services/ConfigService";
import { ReplaceableEventService } from "@/services/replaceable-event";
import { logger } from "@/utils/logger";
import { getRelayUrls } from "@/utils/relays";
/**
 * TENEX CLI: NDK Singleton
 * Manages a single NDK instance for the CLI
 */
import NDK from "@nostr-dev-kit/ndk";

let ndk: NDK | undefined;
let tenexAnnouncementService: ReplaceableEventService | undefined;

export async function initNDK(): Promise<void> {
    if (ndk) {
        // Disconnect existing instance
        if (ndk.pool?.relays) {
            for (const relay of ndk.pool.relays.values()) {
                relay.disconnect();
            }
        }
    }

    const relays = await getRelayUrls();

    ndk = new NDK({
        explicitRelayUrls: [...relays],
        enableOutboxModel: false,
        autoConnectUserRelays: true,
        autoFetchUserMutelist: true,
    });

    await ndk.connect();

    // Initialize TENEX announcement service
    try {
        const privateKey = await config.ensureBackendPrivateKey();
        tenexAnnouncementService = new ReplaceableEventService(ndk, privateKey, 14199);
        await tenexAnnouncementService.initialize();
        logger.debug(
            `TENEX announcement service initialized with pubkey: ${tenexAnnouncementService.getPubkey()}`
        );
    } catch (error) {
        logger.error("Failed to initialize TENEX announcement service", error);
        // Don't fail the entire NDK initialization if announcement service fails
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

export function getTenexAnnouncementService(): ReplaceableEventService | undefined {
    return tenexAnnouncementService;
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
        tenexAnnouncementService = undefined;
    }
}
