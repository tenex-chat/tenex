import { DEFAULT_RELAY_URLS } from "@/constants";
import { config } from "@/services/ConfigService";

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
    // First, check config file
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
