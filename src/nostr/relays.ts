import { config } from "@/services/ConfigService";

/**
 * Default Nostr relay URLs for TENEX
 */
const DEFAULT_RELAY_URLS = ["wss://tenex.chat"];

/**
 * Validate WebSocket URL format
 * @param url - URL to validate
 * @returns true if URL is valid WebSocket URL
 */
function isValidWebSocketUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "ws:" || parsed.protocol === "wss:";
    } catch {
        return false;
    }
}

/**
 * Get relay URLs for NDK connection
 * Priority: config file > defaults
 * @returns Array of validated WebSocket relay URLs
 */
export function getRelayUrls(): string[] {
    // Check config file
    try {
        const tenexConfig = config.getConfig();
        if (tenexConfig.relays && tenexConfig.relays.length > 0) {
            const urls = tenexConfig.relays.filter((url) => isValidWebSocketUrl(url));
            if (urls.length > 0) {
                return urls;
            }
        }
    } catch {
        // Config not loaded yet, fall through to defaults
    }

    // Fall back to defaults
    return DEFAULT_RELAY_URLS;
}
