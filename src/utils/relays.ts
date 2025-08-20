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
 * @returns Array of validated WebSocket relay URLs
 */
export function getRelayUrls(): string[] {
  const relaysEnv = process.env.RELAYS;
  if (relaysEnv?.trim()) {
    const urls = relaysEnv
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0 && isValidWebSocketUrl(url));

    // If after filtering we have no valid URLs, return defaults
    if (urls.length === 0) {
      return DEFAULT_RELAY_URLS;
    }
    return urls;
  }

  return DEFAULT_RELAY_URLS;
}
