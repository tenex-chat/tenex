/**
 * Image Placeholder Strategy for Token Cost Reduction
 *
 * Images in tool results accumulate massive token costs (~1,600 tokens per image).
 * This module implements a placeholder strategy:
 *
 * 1. First appearance: Image is shown in full (agent can see/analyze it)
 * 2. Subsequent appearances: Image is replaced with a text placeholder
 *    that references fs_read(tool='<eventId>') for retrieval
 *
 * This reduces token costs by 95-99% for image-heavy conversations while
 * maintaining retrieval capability.
 */

import type { ToolResultPart } from "ai";
import { isImageUrl } from "./image-url-utils";

/**
 * Prefix used for image placeholders - allows detection of replaced images
 */
export const IMAGE_PLACEHOLDER_PREFIX = "[Image:";

/**
 * Tracker interface for managing which images have been seen in the conversation
 */
export interface ImageTracker {
    /**
     * Check if an image URL has already been seen in this conversation
     */
    hasBeenSeen(imageUrl: string): boolean;

    /**
     * Mark an image URL as seen (typically after first display)
     */
    markAsSeen(imageUrl: string): void;

    /**
     * Get all seen image URLs
     */
    getSeenUrls(): Set<string>;
}

/**
 * Create a new image tracker for a conversation
 */
export function createImageTracker(): ImageTracker {
    const seenUrls = new Set<string>();

    return {
        hasBeenSeen(imageUrl: string): boolean {
            return seenUrls.has(imageUrl);
        },

        markAsSeen(imageUrl: string): void {
            seenUrls.add(imageUrl);
        },

        getSeenUrls(): Set<string> {
            return seenUrls;
        },
    };
}

/**
 * Create a placeholder text for an image that has been seen before.
 *
 * @param imageUrlOrName - The image URL or filename
 * @param eventId - The event ID for retrieval via fs_read
 * @returns Placeholder text with retrieval instructions
 */
export function createImagePlaceholder(
    imageUrlOrName: string,
    eventId: string | undefined
): string {
    // Extract filename from URL if it looks like a URL
    let filename = imageUrlOrName;
    try {
        const url = new URL(imageUrlOrName);
        const pathParts = url.pathname.split("/");
        const lastPart = pathParts[pathParts.length - 1];
        if (lastPart) {
            filename = lastPart;
        }
    } catch {
        // Not a URL, use as-is
    }

    if (eventId) {
        return `${IMAGE_PLACEHOLDER_PREFIX} ${filename} - use fs_read(tool="${eventId}") to retrieve]`;
    }

    // Fallback when eventId is not available (shouldn't happen normally)
    return `${IMAGE_PLACEHOLDER_PREFIX} ${filename} - original context lost, cannot retrieve]`;
}

/**
 * Regex pattern to match HTTP(S) URLs in text.
 * Must match the raw URL as it appears in text, including trailing chars.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;

/**
 * Normalize a raw URL match by removing trailing punctuation and validating.
 * Returns null if the normalized URL is invalid.
 *
 * @param rawUrl - The raw URL as matched from text
 * @returns Object with rawUrl (as matched) and normalizedUrl, or null if invalid
 */
function normalizeImageUrl(rawUrl: string): { rawUrl: string; normalizedUrl: string } | null {
    // Remove trailing punctuation that might have been captured (., ), ], etc.)
    let cleanUrl = rawUrl.replace(/[).,\]]+$/, "");

    try {
        // Validate and normalize via URL constructor
        const normalized = new URL(cleanUrl).href;
        if (isImageUrl(normalized)) {
            return { rawUrl: cleanUrl, normalizedUrl: normalized };
        }
    } catch {
        // Invalid URL after cleanup
    }

    return null;
}

/**
 * Extract image URLs from tool result parts.
 * Returns normalized, deduplicated URLs in order of first occurrence.
 *
 * @param toolData - Array of tool result parts
 * @returns Array of unique normalized image URL strings
 */
export function extractImageUrlsFromToolResult(toolData: ToolResultPart[]): string[] {
    const seen = new Set<string>();
    const imageUrls: string[] = [];

    for (const part of toolData) {
        const text = extractTextFromOutput(part.output);
        if (!text) continue;

        const matches = text.matchAll(new RegExp(URL_PATTERN.source, "gi"));
        for (const match of matches) {
            const result = normalizeImageUrl(match[0]);
            if (result && !seen.has(result.normalizedUrl)) {
                seen.add(result.normalizedUrl);
                imageUrls.push(result.normalizedUrl);
            }
        }
    }

    return imageUrls;
}

/**
 * Count the number of images in a tool result.
 *
 * @param toolData - Array of tool result parts
 * @returns Number of images found
 */
export function countImagesInToolResult(toolData: ToolResultPart[]): number {
    return extractImageUrlsFromToolResult(toolData).length;
}

/**
 * Result from processing tool results with image tracking
 */
export interface ProcessToolResultOutput {
    /** Processed tool result parts with placeholders applied */
    processedParts: ToolResultPart[];
    /** Number of individual URL occurrences replaced with placeholders */
    replacedCount: number;
    /** Number of unique URLs that were replaced (each may appear multiple times) */
    uniqueReplacedCount: number;
}

/**
 * Process a tool result with image tracking.
 *
 * - First-seen images: Preserved as-is, URL is marked as seen
 * - Previously-seen images: URL replaced with placeholder text
 *
 * Uses a match-driven approach: finds all URL occurrences in text via regex,
 * normalizes each match, and replaces ALL occurrences of seen URLs.
 *
 * @param toolData - Array of tool result parts
 * @param tracker - Image tracker for the conversation
 * @param eventId - Event ID for retrieval reference
 * @returns Object with processed tool results and replacement statistics
 */
export function processToolResultWithImageTracking(
    toolData: ToolResultPart[],
    tracker: ImageTracker,
    eventId: string | undefined
): ProcessToolResultOutput {
    let totalReplacedCount = 0;
    const uniqueReplacedUrls = new Set<string>();

    const processedParts = toolData.map((part) => {
        const text = extractTextFromOutput(part.output);
        if (!text) {
            // Non-text output (e.g., JSON), pass through unchanged
            return part;
        }

        // Use regex replace callback for match-driven processing
        // This ensures we find and process every URL occurrence in the text
        const processedText = text.replace(
            new RegExp(URL_PATTERN.source, "gi"),
            (rawMatch) => {
                const result = normalizeImageUrl(rawMatch);
                if (!result) {
                    // Not a valid image URL, keep as-is
                    return rawMatch;
                }

                const { rawUrl, normalizedUrl } = result;

                if (tracker.hasBeenSeen(normalizedUrl)) {
                    // Image already seen - replace with placeholder
                    totalReplacedCount++;
                    uniqueReplacedUrls.add(normalizedUrl);
                    return createImagePlaceholder(normalizedUrl, eventId);
                } else {
                    // First time seeing this image - mark as seen but preserve URL
                    tracker.markAsSeen(normalizedUrl);
                    return rawUrl;
                }
            }
        );

        // Return modified part with updated text
        return {
            ...part,
            output: updateOutputText(part.output, processedText),
        };
    });

    return {
        processedParts: processedParts as ToolResultPart[],
        replacedCount: totalReplacedCount,
        uniqueReplacedCount: uniqueReplacedUrls.size,
    };
}

/**
 * Extract text from a tool result output (various formats)
 */
function extractTextFromOutput(output: unknown): string | null {
    if (typeof output === "string") {
        return output;
    }

    if (output && typeof output === "object" && "value" in output) {
        const value = (output as { value: unknown }).value;
        if (typeof value === "string") {
            return value;
        }
    }

    return null;
}

/**
 * Update the text in a tool result output, preserving the output structure
 */
function updateOutputText(output: unknown, newText: string): unknown {
    if (typeof output === "string") {
        return newText;
    }

    if (output && typeof output === "object" && "value" in output) {
        const existingOutput = output as { type?: string; value: unknown };
        return {
            ...existingOutput,
            value: newText,
        };
    }

    // Unknown format - return as-is
    return output;
}
