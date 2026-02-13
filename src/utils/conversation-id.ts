/**
 * Conversation ID Utilities
 *
 * Centralized utilities for handling conversation IDs throughout the system.
 */

import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import type { ShortEventId, FullEventId } from "@/types/event-ids";
import { SHORT_EVENT_ID_LENGTH } from "@/types/event-ids";

/**
 * Shorten a conversation ID for Jaeger span attributes.
 * Uses the standard PREFIX_LENGTH (12 characters) for consistency across all traces.
 * This makes Jaeger UI more readable with reduced length and low collision risk.
 *
 * Note: 12 hex characters provides 48 bits of entropy (2^48 ≈ 281 trillion combinations),
 * which gives very low collision probability for typical conversation volumes.
 *
 * @param conversationId - Full conversation ID (can be typed FullEventId or plain string)
 * @returns Shortened ID (first 12 characters) as ShortEventId
 */
export function shortenConversationId(conversationId: string | FullEventId): ShortEventId {
    return conversationId.substring(0, SHORT_EVENT_ID_LENGTH).toLowerCase() as ShortEventId;
}

// Re-export PREFIX_LENGTH for backward compatibility
export { PREFIX_LENGTH };
