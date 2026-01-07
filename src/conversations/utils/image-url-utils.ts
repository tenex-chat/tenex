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
