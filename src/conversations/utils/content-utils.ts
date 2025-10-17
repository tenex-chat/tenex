/**
 * Content utilities for processing conversation messages
 * Purpose: Strip <thinking>...</thinking> blocks from conversation history; skip messages that are purely thinking blocks.
 * Also filter out events with reasoning tags.
 */

import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

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
        .map(line => {
            // Only collapse spaces in the middle of lines, not at the start (preserve indentation)
            if (line.trimStart() !== line) {
                // Line has leading whitespace - preserve it
                const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
                const rest = line.slice(leadingWhitespace.length);
                return leadingWhitespace + rest.replace(/  +/g, " ");
            }
            // No leading whitespace - collapse all multiple spaces
            return line.replace(/  +/g, " ");
        })
        .join("\n")
        .replace(/\n\s*\n+/g, "\n")  // Collapse 2+ newlines to single newline
        .trim();                      // Trim leading/trailing whitespace
    
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
    return event.tags.some(tag => tag[0] === "reasoning" && tag.length === 1);
}

/**
 * Log thinking block removal for debugging
 * @param eventId - The event ID being processed
 * @param originalLength - Original content length
 * @param strippedLength - Length after stripping
 */
export function logThinkingBlockRemoval(
    eventId: string, 
    originalLength: number, 
    strippedLength: number
): void {
    if (originalLength !== strippedLength) {
        logger.debug("[CONTENT_UTILS] Removed thinking blocks from content", {
            eventId: eventId.substring(0, 8),
            originalLength,
            strippedLength,
            removed: originalLength - strippedLength
        });
    }
}