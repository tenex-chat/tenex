/**
 * Nostr ID Shortening Utilities
 *
 * Centralized helpers for shortening conversation IDs, event IDs, and pubkeys.
 */

import type { ShortEventId, FullEventId } from "@/types/event-ids";
import { SHORT_EVENT_ID_LENGTH } from "@/types/event-ids";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";

function shortenHexIdentifier(value: string | FullEventId): ShortEventId {
    return value.substring(0, SHORT_EVENT_ID_LENGTH).toLowerCase() as ShortEventId;
}

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
    return shortenHexIdentifier(conversationId);
}

export function shortenOptionalConversationId(
    conversationId?: string | FullEventId | null
): ShortEventId | undefined {
    return conversationId ? shortenConversationId(conversationId) : undefined;
}

export function shortenEventId(eventId: string | FullEventId): ShortEventId {
    return shortenHexIdentifier(eventId);
}

export function shortenOptionalEventId(
    eventId?: string | FullEventId | null
): ShortEventId | undefined {
    return eventId ? shortenEventId(eventId) : undefined;
}

export function shortenPubkey(pubkey: string): string {
    return shortenHexIdentifier(pubkey);
}

export function shortenOptionalPubkey(pubkey?: string | null): string | undefined {
    return pubkey ? shortenPubkey(pubkey) : undefined;
}

// Re-export PREFIX_LENGTH for backward compatibility
export { PREFIX_LENGTH };
