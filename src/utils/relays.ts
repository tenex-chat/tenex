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
 * Get relay URLs for NDK connection.
 * Priority: config file > defaults.
 * If config file is not found, it will be created with default relays.
 * @returns Array of validated WebSocket relay URLs
 */
export async function getRelayUrls(): Promise<string[]> {
    try {
        const loadedConfig = await config.loadTenexConfig(config.getGlobalPath());
        if (loadedConfig.relays && loadedConfig.relays.length > 0) {
            const urls = loadedConfig.relays.filter(isValidWebSocketUrl);
            if (urls.length > 0) {
                return urls;
            }
        }
        // If config is loaded but relays are missing/empty, save defaults
        loadedConfig.relays = DEFAULT_RELAY_URLS;
        await config.saveGlobalConfig(loadedConfig);
        return DEFAULT_RELAY_URLS;
    } catch (error) {
        // This catch block will handle errors from loadTenexConfig or saveGlobalConfig
        // Fallback to default relays in case of any error
        return DEFAULT_RELAY_URLS;
    }
}
