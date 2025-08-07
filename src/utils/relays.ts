/**
 * Default Nostr relay URLs for TENEX
 */
const DEFAULT_RELAY_URLS = ["wss://tenex.chat"];

/**
 * Get relay URLs for NDK connection
 */
export function getRelayUrls(): string[] {
    const relaysEnv = process.env.RELAYS;
    if (relaysEnv && relaysEnv.trim()) {
        const urls = relaysEnv
            .split(",")
            .map((url) => url.trim())
            .filter((url) => url.length > 0); // Filter out empty strings
        
        // If after filtering we have no valid URLs, return defaults
        if (urls.length === 0) {
            return DEFAULT_RELAY_URLS;
        }
        return urls;
    }

    return DEFAULT_RELAY_URLS;
}
