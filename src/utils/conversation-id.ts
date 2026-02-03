/**
 * Conversation ID Utilities
 *
 * Centralized utilities for handling conversation IDs throughout the system.
 */

import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";

/**
 * Shorten a conversation ID for Jaeger span attributes.
 * Uses the standard PREFIX_LENGTH (12 characters) for consistency across all traces.
 * This makes Jaeger UI more readable with reduced length and low collision risk.
 *
 * Note: 12 hex characters provides 48 bits of entropy (2^48 ≈ 281 trillion combinations),
 * which gives very low collision probability for typical conversation volumes.
 *
 * @param conversationId - Full conversation ID
 * @returns Shortened ID (first 12 characters)
 */
export function shortenConversationId(conversationId: string): string {
    return conversationId.substring(0, PREFIX_LENGTH);
}
