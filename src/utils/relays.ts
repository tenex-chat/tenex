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
 * Priority: environment variable > config file > defaults
 * @returns Array of validated WebSocket relay URLs
 */
export function getRelayUrls(): string[] {
    // First check environment variable (highest priority)
    const relaysEnv = process.env.RELAYS;
    if (relaysEnv?.trim()) {
        const urls = relaysEnv
            .split(",")
            .map((url) => url.trim())
            .filter((url) => url.length > 0 && isValidWebSocketUrl(url));

        if (urls.length > 0) {
            return urls;
        }
    }

    // Then check config file
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

    // Finally fall back to defaults
    return DEFAULT_RELAY_URLS;
}
