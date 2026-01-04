/**
 * Content utilities for processing conversation messages
 * Purpose: Strip <thinking>...</thinking> blocks from conversation history; skip messages that are purely thinking blocks.
 * Also filter out events with reasoning tags.
 * Also extract and fetch images from message content for multimodal LLM support.
 */

import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import type { ImagePart, TextPart } from "ai";

/**
 * Regex pattern to match thinking blocks (case-insensitive, multi-line)
 * Matches: <thinking>, <Thinking>, <THINKING> with any attributes and their closing tags
 */
const THINKING_BLOCK_REGEX = /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi;

/**
 * Remove all thinking blocks from content
 * @param content - The content to process
 * @returns The content with all thinking blocks removed and normalized whitespace (multiple blank lines collapsed to single newline)
 */
export function stripThinkingBlocks(content: string): string {
    if (!content) return "";

    // Remove all thinking blocks
    let stripped = content.replace(THINKING_BLOCK_REGEX, "");

    // Normalize whitespace more carefully:
    // 1. Only collapse multiple spaces that aren't at the beginning of a line (preserve indentation)
    // 2. Collapse multiple blank lines to a single newline
    stripped = stripped
        .split("\n")
        .map((line) => {
            // Only collapse spaces in the middle of lines, not at the start (preserve indentation)
            if (line.trimStart() !== line) {
                // Line has leading whitespace - preserve it
                const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
                const rest = line.slice(leadingWhitespace.length);
                return leadingWhitespace + rest.replace(/ {2,}/g, " ");
            }
            // No leading whitespace - collapse all multiple spaces
            return line.replace(/ {2,}/g, " ");
        })
        .join("\n")
        .replace(/\n\s*\n+/g, "\n") // Collapse 2+ newlines to single newline
        .trim(); // Trim leading/trailing whitespace

    return stripped;
}

/**
 * Check if content contains only thinking blocks (no other content)
 * @param content - The content to check
 * @returns True if the content is empty after removing thinking blocks
 */
export function isOnlyThinkingBlocks(content: string): boolean {
    if (!content || content.trim().length === 0) return false; // Empty/whitespace content is not "only thinking blocks"

    const stripped = stripThinkingBlocks(content);
    return stripped.length === 0;
}

/**
 * Check if content contains any thinking blocks
 * @param content - The content to check
 * @returns True if the content contains at least one thinking block
 */
export function hasThinkingBlocks(content: string): boolean {
    if (!content) return false;
    // Reset regex lastIndex since we're using the global flag
    THINKING_BLOCK_REGEX.lastIndex = 0;
    return THINKING_BLOCK_REGEX.test(content);
}

/**
 * Count the number of thinking blocks in content
 * @param content - The content to analyze
 * @returns The number of thinking blocks found
 */
export function countThinkingBlocks(content: string): number {
    if (!content) return 0;
    const matches = content.match(THINKING_BLOCK_REGEX);
    return matches ? matches.length : 0;
}

/**
 * Check if an event has a reasoning tag
 * @param event - The NDK event to check
 * @returns True if the event has a ["reasoning"] tag
 */
export function hasReasoningTag(event: NDKEvent): boolean {
    if (!event.tags) return false;
    return event.tags.some((tag) => tag[0] === "reasoning" && tag.length === 1);
}

/**
 * Common image file extensions and their MIME types
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
};

/**
 * Regex pattern to match image URLs in content
 * Matches http/https URLs that end with common image extensions
 * or URLs from known image hosting services
 */
const IMAGE_URL_REGEX =
    /https?:\/\/[^\s<>"{}|\\^`[\]]+\.(?:jpg|jpeg|png|gif|webp|svg|bmp|ico)(?:\?[^\s<>"{}|\\^`[\]]*)?/gi;

/**
 * Additional patterns for image URLs that don't have file extensions
 * (e.g., image hosting services with query parameters)
 */
const IMAGE_HOSTING_PATTERNS = [
    /https?:\/\/(?:i\.)?imgur\.com\/[a-zA-Z0-9]+/gi,
    /https?:\/\/pbs\.twimg\.com\/[^\s<>"{}|\\^`[\]]+/gi,
    /https?:\/\/[^\s<>"{}|\\^`[\]]*blossom[^\s<>"{}|\\^`[\]]+/gi,
    /https?:\/\/nostr\.build\/[^\s<>"{}|\\^`[\]]+/gi,
    /https?:\/\/image\.nostr\.build\/[^\s<>"{}|\\^`[\]]+/gi,
    /https?:\/\/void\.cat\/d\/[^\s<>"{}|\\^`[\]]+/gi,
];

/**
 * Extracted image URL with its position in the content
 */
export interface ExtractedImageUrl {
    url: string;
    startIndex: number;
    endIndex: number;
}

/**
 * Extract all image URLs from content
 * @param content - The content to search for image URLs
 * @returns Array of extracted image URLs with their positions
 */
export function extractImageUrls(content: string): ExtractedImageUrl[] {
    if (!content) return [];

    const results: ExtractedImageUrl[] = [];
    const seenUrls = new Set<string>();

    // Match URLs with image extensions
    IMAGE_URL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_URL_REGEX.exec(content)) !== null) {
        if (!seenUrls.has(match[0])) {
            seenUrls.add(match[0]);
            results.push({
                url: match[0],
                startIndex: match.index,
                endIndex: match.index + match[0].length,
            });
        }
    }

    // Match image hosting service URLs
    for (const pattern of IMAGE_HOSTING_PATTERNS) {
        pattern.lastIndex = 0;
        while ((match = pattern.exec(content)) !== null) {
            if (!seenUrls.has(match[0])) {
                seenUrls.add(match[0]);
                results.push({
                    url: match[0],
                    startIndex: match.index,
                    endIndex: match.index + match[0].length,
                });
            }
        }
    }

    // Sort by position in content
    return results.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Determine MIME type from URL
 * @param url - The image URL
 * @returns The MIME type or undefined if unknown
 */
export function getMimeTypeFromUrl(url: string): string | undefined {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname.toLowerCase();
        const extension = pathname.split(".").pop();
        if (extension && IMAGE_EXTENSIONS[extension]) {
            return IMAGE_EXTENSIONS[extension];
        }
    } catch {
        // Invalid URL, return undefined
    }
    return undefined;
}

/**
 * Fetched image result
 */
export interface FetchedImage {
    url: string;
    data: Uint8Array;
    mediaType: string;
}

/**
 * Fetch an image from a URL
 * @param url - The image URL to fetch
 * @returns The fetched image data or null if fetch failed
 */
export async function fetchImage(url: string): Promise<FetchedImage | null> {
    const tracer = trace.getTracer("content-utils");

    return tracer.startActiveSpan("fetchImage", async (span) => {
        span.setAttribute("image.url", url);

        try {
            const response = await fetch(url, {
                headers: {
                    Accept: "image/*",
                    "User-Agent": "TENEX/1.0",
                },
                signal: AbortSignal.timeout(10000), // 10 second timeout
            });

            if (!response.ok) {
                span.setAttribute("image.fetch.status", response.status);
                span.setAttribute("image.fetch.error", `HTTP ${response.status}`);
                logger.warn("[CONTENT_UTILS] Failed to fetch image", {
                    url,
                    status: response.status,
                });
                span.end();
                return null;
            }

            const contentType = response.headers.get("content-type");
            const arrayBuffer = await response.arrayBuffer();
            const data = new Uint8Array(arrayBuffer);

            // Determine media type from content-type header or URL
            let mediaType = contentType?.split(";")[0].trim();
            if (!mediaType || !mediaType.startsWith("image/")) {
                mediaType = getMimeTypeFromUrl(url) || "image/jpeg";
            }

            span.setAttribute("image.fetch.status", 200);
            span.setAttribute("image.mediaType", mediaType);
            span.setAttribute("image.size", data.length);

            logger.debug("[CONTENT_UTILS] Fetched image successfully", {
                url,
                mediaType,
                size: data.length,
            });

            span.end();
            return { url, data, mediaType };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            span.setAttribute("image.fetch.error", errorMessage);
            logger.warn("[CONTENT_UTILS] Error fetching image", { url, error: errorMessage });
            span.end();
            return null;
        }
    });
}

/**
 * Result of building multimodal content
 */
export type MultimodalContent = string | Array<TextPart | ImagePart>;

/**
 * Build multimodal content from text with embedded image URLs
 * Fetches images and returns content suitable for AI SDK UserContent
 * @param content - The original text content
 * @returns Multimodal content array or original string if no images
 */
export async function buildMultimodalContent(content: string): Promise<MultimodalContent> {
    const tracer = trace.getTracer("content-utils");

    return tracer.startActiveSpan("buildMultimodalContent", async (span) => {
        const imageUrls = extractImageUrls(content);

        if (imageUrls.length === 0) {
            span.setAttribute("content.hasImages", false);
            span.end();
            return content;
        }

        span.setAttribute("content.hasImages", true);
        span.setAttribute("content.imageCount", imageUrls.length);
        span.addEvent("image_urls_extracted", {
            urls: imageUrls.map((i) => i.url).join(", "),
        });

        // Fetch all images in parallel
        const fetchPromises = imageUrls.map((img) => fetchImage(img.url));
        const fetchedImages = await Promise.all(fetchPromises);

        // Build content parts
        const parts: Array<TextPart | ImagePart> = [];
        let lastIndex = 0;
        let successfulFetches = 0;
        let imageNumber = 0;

        for (let i = 0; i < imageUrls.length; i++) {
            const imageUrl = imageUrls[i];
            const fetchedImage = fetchedImages[i];

            // Add text before this image URL
            if (imageUrl.startIndex > lastIndex) {
                const textBefore = content.slice(lastIndex, imageUrl.startIndex).trim();
                if (textBefore) {
                    parts.push({ type: "text", text: textBefore });
                }
            }

            if (fetchedImage) {
                imageNumber++;
                // Add explicit marker so model knows which image is which
                parts.push({ type: "text", text: `[Image ${imageNumber}]` });
                // Add the fetched image
                parts.push({
                    type: "image",
                    image: fetchedImage.data,
                    mediaType: fetchedImage.mediaType,
                });
                successfulFetches++;

                span.addEvent("image_fetched", {
                    url: fetchedImage.url,
                    mediaType: fetchedImage.mediaType,
                    size: fetchedImage.data.length,
                    imageNumber,
                });
            } else {
                // Image fetch failed, keep the URL as text so user knows which failed
                parts.push({ type: "text", text: `[Image failed to load: ${imageUrl.url}]` });

                span.addEvent("image_fetch_failed", {
                    url: imageUrl.url,
                });
            }

            lastIndex = imageUrl.endIndex;
        }

        // Add any remaining text after the last image URL
        if (lastIndex < content.length) {
            const textAfter = content.slice(lastIndex).trim();
            if (textAfter) {
                parts.push({ type: "text", text: textAfter });
            }
        }

        span.setAttribute("content.successfulFetches", successfulFetches);
        span.setAttribute("content.partCount", parts.length);

        // If no images were successfully fetched, return original string
        if (successfulFetches === 0) {
            span.addEvent("no_images_fetched_returning_string");
            span.end();
            return content;
        }

        logger.debug("[CONTENT_UTILS] Built multimodal content", {
            imageCount: imageUrls.length,
            successfulFetches,
            partCount: parts.length,
        });

        span.end();
        return parts;
    });
}
