import { configService } from "@/services/ConfigService";

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
        const config = await configService.loadTenexConfig(configService.getGlobalPath());
        if (config.relays && config.relays.length > 0) {
            const urls = config.relays.filter(isValidWebSocketUrl);
            if (urls.length > 0) {
                return urls;
            }
        }
        // If config is loaded but relays are missing/empty, save defaults
        config.relays = DEFAULT_RELAY_URLS;
        await configService.saveGlobalConfig(config);
        return DEFAULT_RELAY_URLS;
    } catch (error) {
        // This catch block will handle errors from loadTenexConfig or saveGlobalConfig
        // Fallback to default relays in case of any error
        return DEFAULT_RELAY_URLS;
    }
}
