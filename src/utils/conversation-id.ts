/**
 * Nostr ID Shortening Utilities
 *
 * Centralized helpers for shortening conversation IDs, event IDs, and pubkeys.
 */

import { createHash } from "node:crypto";
import type { ShortEventId, FullEventId } from "@/types/event-ids";
import { SHORT_EVENT_ID_LENGTH } from "@/types/event-ids";
import { PUBKEY_DISPLAY_LENGTH } from "@/utils/nostr-entity-parser";

/**
 * Shorten an event ID or conversation ID to 10 characters for display.
 * Handles special cases like Telegram IDs (tg_*) by hashing them.
 */
function shortenEventIdentifier(value: string | FullEventId): ShortEventId {
    // Handle Telegram conversation IDs (e.g., tg_599309204_123)
    // Use cryptographic hash to avoid collisions between similar numeric patterns
    if (typeof value === 'string' && value.startsWith('tg_')) {
        // Hash the full ID to get deterministic 10-char hex prefix
        // SHA-256 provides strong collision resistance even with truncation
        const hash = createHash('sha256').update(value).digest('hex');
        return hash.substring(0, 10).toLowerCase() as ShortEventId;
    }

    // Normal event ID shortening (first 10 chars)
    return value.substring(0, SHORT_EVENT_ID_LENGTH).toLowerCase() as ShortEventId;
}

/**
 * Shorten a pubkey to 6 characters for display.
 */
function shortenPubkeyIdentifier(pubkey: string): string {
    return pubkey.substring(0, PUBKEY_DISPLAY_LENGTH).toLowerCase();
}

/**
 * Shorten a conversation ID for Jaeger span attributes.
 * Uses 10 characters for consistency across all traces.
 * This makes Jaeger UI more readable with reduced length and low collision risk.
 *
 * Note: 10 hex characters provides 40 bits of entropy (2^40 ≈ 1.1 trillion combinations),
 * which gives very low collision probability for typical workloads. For special IDs like
 * Telegram conversation IDs (e.g., tg_599309204_123), these are hashed to 10-char hex.
 *
 * @param conversationId - Full conversation ID (can be typed FullEventId or plain string)
 * @returns Shortened ID (10 characters) as ShortEventId
 */
export function shortenConversationId(conversationId: string | FullEventId): ShortEventId {
    return shortenEventIdentifier(conversationId);
}

export function shortenOptionalConversationId(
    conversationId?: string | FullEventId | null
): ShortEventId | undefined {
    return conversationId ? shortenConversationId(conversationId) : undefined;
}

export function shortenEventId(eventId: string | FullEventId): ShortEventId {
    return shortenEventIdentifier(eventId);
}

export function shortenOptionalEventId(
    eventId?: string | FullEventId | null
): ShortEventId | undefined {
    return eventId ? shortenEventId(eventId) : undefined;
}

export function shortenPubkey(pubkey: string): string {
    return shortenPubkeyIdentifier(pubkey);
}

export function shortenOptionalPubkey(pubkey?: string | null): string | undefined {
    return pubkey ? shortenPubkey(pubkey) : undefined;
}

// Re-export constants for backward compatibility
export { PUBKEY_DISPLAY_LENGTH };
