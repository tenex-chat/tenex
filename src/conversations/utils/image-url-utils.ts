/**
 * Utilities for detecting and extracting image URLs from message content.
 *
 * These utilities help convert text messages containing image URLs into
 * multimodal messages compatible with the AI SDK's ImagePart format.
 */

/**
 * Supported image file extensions (lowercase, with leading dot)
 */
export const IMAGE_EXTENSIONS = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".svg",
] as const;

/**
 * Regex pattern to match HTTP(S) URLs
 * Captures URLs that start with http:// or https://
 */
const URL_PATTERN = /https?:\/\/[^\s<>"\]()]+/gi;

/**
 * Domains that should be skipped for image fetching.
 * These are either reserved example domains (RFC 2606), localhost/development domains,
 * or other non-routable domains that will fail to fetch.
 */
const SKIP_DOMAINS = new Set([
    // RFC 2606 reserved example domains
    "example.com",
    "example.org",
    "example.net",
    "example.edu",
    // Localhost variants
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "[::1]",
    // Common development/test domains
    "test",
    "invalid",
    "local",
]);

/**
 * Check if a URL should be skipped for image fetching.
 * Returns true for URLs on reserved/example/localhost domains that
 * will fail to fetch and could crash the agent.
 *
 * @param url - The URL string to check
 * @returns true if the URL should be skipped, false if it can be fetched
 */
export function shouldSkipImageUrl(url: string): boolean {
    if (!url) return true;

    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();

        // Check exact match against skip domains
        if (SKIP_DOMAINS.has(hostname)) {
            return true;
        }

        // Check for subdomains of example domains (e.g., cdn.example.com, www.example.org)
        for (const skipDomain of SKIP_DOMAINS) {
            if (hostname.endsWith(`.${skipDomain}`)) {
                return true;
            }
        }

        // Check for .local, .test, .invalid, .localhost TLDs (RFC 2606 / RFC 6761)
        if (
            hostname.endsWith(".local") ||
            hostname.endsWith(".test") ||
            hostname.endsWith(".invalid") ||
            hostname.endsWith(".localhost") ||
            hostname.endsWith(".example")
        ) {
            return true;
        }

        return false;
    } catch {
        // Invalid URL - skip it
        return true;
    }
}

/**
 * Check if a URL string points to an image based on its file extension.
 * Handles URLs with query parameters and fragments.
 *
 * @param url - The URL string to check
 * @returns true if the URL appears to be an image, false otherwise
 */
export function isImageUrl(url: string): boolean {
    if (!url) return false;

    try {
        const parsedUrl = new URL(url);
        // Only accept http/https protocols
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            return false;
        }

        // Get the pathname and check the extension (ignoring query params and fragments)
        const pathname = parsedUrl.pathname.toLowerCase();

        return IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
    } catch {
        // Invalid URL
        return false;
    }
}

/**
 * Extract all image URLs from a text string.
 * Returns deduplicated URLs in order of first occurrence.
 *
 * @param text - The text content to search for image URLs
 * @returns Array of unique image URL strings
 */
export function extractImageUrls(text: string): string[] {
    if (!text) return [];

    // Find all URLs in the text
    const allUrls = text.match(URL_PATTERN) || [];

    // Filter to only image URLs and deduplicate
    const seen = new Set<string>();
    const imageUrls: string[] = [];

    for (const url of allUrls) {
        // Clean up URL (remove trailing punctuation that might have been captured)
        let cleanUrl = url.replace(/[),.]+$/, "");

        try {
            // Validate and normalize
            cleanUrl = new URL(cleanUrl).href;
        } catch {
            continue; // Skip invalid URLs encountered during cleanup
        }

        if (isImageUrl(cleanUrl) && !seen.has(cleanUrl)) {
            seen.add(cleanUrl);
            imageUrls.push(cleanUrl);
        }
    }

    return imageUrls;
}
