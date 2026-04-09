import { config } from "@/services/ConfigService";

/**
 * Default Nostr relay URLs for TENEX
 */
const DEFAULT_RELAY_URLS = ["wss://tenex.chat"];

/**
 * Default identity relay URLs - used for publishing kind:0 profile events
 */
const DEFAULT_IDENTITY_RELAY_URLS = ["wss://purplepag.es"];

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
 * Priority: env $RELAYS > config file > defaults
 * @returns Array of validated WebSocket relay URLs
 */
export function getRelayUrls(): string[] {
    // Check environment variable first (agent-specific relays)
    const envRelays = process.env.RELAYS;
    if (envRelays) {
        const urls = envRelays
            .split(",")
            .map((url) => url.trim())
            .filter((url) => url && isValidWebSocketUrl(url));
        if (urls.length > 0) {
            return urls;
        }
    }

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

/**
 * Get identity relay URLs for publishing kind:0 profile events.
 * These are published in addition to the regular relay set.
 * Priority: config file > defaults (wss://purplepag.es)
 * @returns Array of validated WebSocket relay URLs
 */
export function getIdentityRelayUrls(): string[] {
    try {
        const tenexConfig = config.getConfig();
        if (tenexConfig.identityRelays && tenexConfig.identityRelays.length > 0) {
            const urls = tenexConfig.identityRelays.filter((url) => isValidWebSocketUrl(url));
            if (urls.length > 0) {
                return urls;
            }
        }
    } catch {
        // Config not loaded yet, fall through to defaults
    }

    return DEFAULT_IDENTITY_RELAY_URLS;
}
