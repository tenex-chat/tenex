/**
 * Default Nostr relay URLs for TENEX
 */
const DEFAULT_RELAY_URLS = ["wss://tenex.chat"];

/**
 * Get relay URLs for NDK connection
 */
export function getRelayUrls(): string[] {
    const relaysEnv = process.env.RELAYS;
    if (relaysEnv) {
        return relaysEnv.split(",").map((url) => url.trim());
    }

    return DEFAULT_RELAY_URLS;
}
