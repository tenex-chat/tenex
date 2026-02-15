/**
 * Utilities for converting text content with image URLs to AI SDK multimodal format.
 *
 * The AI SDK supports multimodal user messages with content arrays containing
 * TextPart and ImagePart objects. This module converts plain text messages
 * containing image URLs into the appropriate multimodal format.
 *
 * @see https://ai-sdk.dev/docs/foundations/prompts#multi-modal-messages
 */

import type { TextPart, ImagePart } from "ai";
import { extractImageUrls, shouldSkipImageUrl } from "./image-url-utils";

/**
 * Type representing multimodal content for user messages.
 * Can be a simple string (no images) or an array of text/image parts.
 */
export type MultimodalContent = string | Array<TextPart | ImagePart>;

/**
 * Check if text content contains any image URLs.
 * Use this to determine if multimodal conversion is needed.
 *
 * @param content - The text content to check
 * @returns true if the content contains image URLs
 */
export function hasImageUrls(content: string): boolean {
    return extractImageUrls(content).length > 0;
}

/**
 * Convert text content to multimodal content if it contains image URLs.
 *
 * If the content contains image URLs:
 * - Returns an array with:
 *   1. A TextPart containing the full original text (preserves context)
 *   2. ImageParts for each unique image URL (using URL objects for AI SDK to fetch)
 *
 * If no image URLs are found:
 * - Returns the original string unchanged
 *
 * @param content - The text content to convert
 * @returns Either the original string or a multimodal content array
 */
export function convertToMultimodalContent(content: string): MultimodalContent {
    if (!content) return content;

    const imageUrls = extractImageUrls(content);

    // No images - return as-is
    if (imageUrls.length === 0) {
        return content;
    }

    // Build multimodal content array
    const parts: Array<TextPart | ImagePart> = [];

    // Add the full text content first (preserves context and attribution)
    parts.push({
        type: "text",
        text: content,
    } satisfies TextPart);

    // Add each image as an ImagePart with URL reference
    // The AI SDK will fetch the images automatically
    // Skip URLs on non-routable domains (example.com, localhost, etc.) that would fail
    for (const imageUrl of imageUrls) {
        // Skip URLs that cannot be fetched (example domains, localhost, etc.)
        // These would cause the AI SDK fetch to fail and crash the agent
        if (shouldSkipImageUrl(imageUrl)) {
            continue;
        }

        // Note: new URL() here should never throw because extractImageUrls
        // already validates and normalizes URLs. The ImagePart uses URL objects
        // as per AI SDK spec, allowing the SDK to fetch the images.
        parts.push({
            type: "image",
            image: new URL(imageUrl),
        } satisfies ImagePart);
    }

    // If all image URLs were skipped (non-fetchable domains), return original string
    // parts[0] is always the TextPart, so if length is 1, no images were added
    if (parts.length === 1) {
        return content;
    }

    return parts;
}
