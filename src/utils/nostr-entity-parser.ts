import type NDK from "@nostr-dev-kit/ndk";
import { type NDKEvent, NDKUser } from "@nostr-dev-kit/ndk";
import { prefixKVStore } from "@/services/storage";
import { nip19 } from "nostr-tools";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { FullEventId, ShortEventId } from "@/types/event-ids";
import { isFullEventId, isShortEventId } from "@/types/event-ids";

/**
 * The standard prefix length used for shortened hex IDs throughout the system.
 * Used for delegation IDs, conversation IDs, and other nostr identifiers.
 */
export const PREFIX_LENGTH = 12;

/**
 * Parses various Nostr user identifier formats into a pubkey
 * Handles: npub, nprofile, hex pubkey, with or without "nostr:" prefix
 *
 * @param input - The user identifier in various formats
 * @param ndk - NDK instance for validation
 * @returns The parsed pubkey or null if invalid
 */
export function parseNostrUser(input: string | undefined): string | null {
    if (!input) return null;

    try {
        // Strip nostr: prefix if present
        let cleaned = input.trim();
        if (cleaned.startsWith("nostr:")) {
            cleaned = cleaned.substring(6);
        }

        // Handle npub format
        if (cleaned.startsWith("npub1")) {
            const user = new NDKUser({ npub: cleaned });
            return user.pubkey;
        }

        // Handle nprofile format
        if (cleaned.startsWith("nprofile1")) {
            const user = new NDKUser({ nprofile: cleaned });
            return user.pubkey;
        }

        // Assume it's a hex pubkey - validate format
        if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
            return cleaned.toLowerCase();
        }

        // Try to create user anyway in case it's a valid format we didn't check
        try {
            const user = new NDKUser({ pubkey: cleaned });
            if (user.pubkey && /^[0-9a-fA-F]{64}$/.test(user.pubkey)) {
                return user.pubkey;
            }
        } catch {
            // Ignore and return null
        }

        return null;
    } catch (error) {
        console.debug("Failed to parse Nostr user identifier:", input, error);
        return null;
    }
}

/**
 * Parses various Nostr event identifier formats and fetches the event
 * Handles: nevent, note, naddr, hex event id, with or without "nostr:" prefix
 *
 * @param input - The event identifier in various formats
 * @param ndk - NDK instance for fetching
 * @returns The fetched event or null if not found/invalid
 */
export async function parseNostrEvent(
    input: string | undefined,
    ndk: NDK
): Promise<NDKEvent | null> {
    if (!input) return null;

    try {
        // Strip nostr: prefix if present
        let cleaned = input.trim();
        if (cleaned.startsWith("nostr:")) {
            cleaned = cleaned.substring(6);
        }

        // Try to fetch directly - NDK handles various formats
        if (
            cleaned.startsWith("nevent1") ||
            cleaned.startsWith("note1") ||
            cleaned.startsWith("naddr1")
        ) {
            const event = await ndk.fetchEvent(cleaned);
            return event;
        }

        // Try as hex event ID
        if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
            const event = await ndk.fetchEvent(cleaned);
            return event;
        }

        // Last attempt - try to fetch as-is
        const event = await ndk.fetchEvent(cleaned);
        return event;
    } catch (error) {
        console.debug("Failed to parse/fetch Nostr event:", input, error);
        return null;
    }
}

/**
 * Validates and normalizes a Nostr identifier, removing prefixes
 * Returns the cleaned identifier or null if invalid
 */
export function normalizeNostrIdentifier(input: string | undefined): string | null {
    if (!input) return null;

    let cleaned = input.trim();
    if (cleaned.startsWith("nostr:")) {
        cleaned = cleaned.substring(6);
    }

    // Basic validation - should be bech32 or hex
    if (
        cleaned.match(/^(npub1|nprofile1|nevent1|note1|nsec1|naddr1)[0-9a-z]+$/i) ||
        cleaned.match(/^[0-9a-fA-F]{64}$/)
    ) {
        return cleaned;
    }

    return null;
}

/**
 * Checks if a string looks like a 12-char hex prefix (potential shorthand ID).
 * Note: This is a pure format check - it doesn't do any lookup.
 * For resolving prefixes to actual IDs, use the appropriate service.
 */
export function isHexPrefix(input: string | undefined): boolean {
    if (!input) return false;
    return /^[0-9a-fA-F]{12}$/.test(input.trim());
}

/**
 * Resolves a 12-character hex prefix to a full 64-character ID using PrefixKVStore.
 * This enables shorthand references to event IDs and pubkeys.
 *
 * IMPORTANT: This function is TYPE-AGNOSTIC - it returns any matching ID without
 * validating whether it's an event ID or pubkey. For resolving specifically to
 * agent pubkeys, use `resolveAgentSlug` from the AgentResolution service.
 *
 * @param prefix - A 12-character hex string prefix
 * @returns The full 64-character ID, or null if not found or invalid input
 */
export function resolvePrefixToId(prefix: string | undefined): string | null {
    if (!prefix) return null;

    const cleaned = prefix.trim().toLowerCase();

    // Must be exactly 12 hex characters
    if (!/^[0-9a-f]{12}$/.test(cleaned)) {
        return null;
    }

    // Check if store is initialized (best-effort lookup)
    if (!prefixKVStore.isInitialized()) {
        console.debug("[resolvePrefixToId] PrefixKVStore not initialized, cannot resolve prefix");
        return null;
    }

    // Wrap lookup in try/catch - LMDB can throw
    try {
        return prefixKVStore.lookup(cleaned);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.debug("[resolvePrefixToId] Prefix lookup failed:", cleaned, message);
        return null;
    }
}

/**
 * Resolves various event ID formats to a typed FullEventId.
 *
 * Accepts:
 * - Full 64-character hex IDs (returns as-is after validation)
 * - 12-character hex prefixes (resolved via PrefixKVStore)
 * - NIP-19 formats: note1..., nevent1...
 * - nostr: prefixed versions of all the above
 *
 * @param input - The event ID in any supported format
 * @returns A typed FullEventId, or null if resolution failed
 */
export function resolveToFullEventId(input: string | undefined): FullEventId | null {
    if (!input) return null;

    const trimmed = input.trim();

    // Strip nostr: prefix if present
    const cleaned = trimmed.startsWith("nostr:") ? trimmed.slice(6) : trimmed;
    const normalized = cleaned.toLowerCase();

    // 1. Check for full 64-char hex ID
    if (isFullEventId(normalized)) {
        return normalized;
    }

    // 2. Check for 12-char hex prefix
    if (isShortEventId(normalized)) {
        const resolved = resolvePrefixToId(normalized);
        if (resolved && isFullEventId(resolved)) {
            return resolved;
        }
        return null;
    }

    // 3. Try NIP-19 decoding (note1..., nevent1...)
    try {
        const decoded = nip19.decode(cleaned);
        if (decoded.type === "note" && typeof decoded.data === "string") {
            const eventId = decoded.data.toLowerCase();
            if (isFullEventId(eventId)) {
                return eventId;
            }
        }
        if (decoded.type === "nevent" && typeof decoded.data === "object" && decoded.data !== null) {
            const data = decoded.data as { id: string };
            const eventId = data.id.toLowerCase();
            if (isFullEventId(eventId)) {
                return eventId;
            }
        }
    } catch {
        // Not a valid NIP-19 format
    }

    return null;
}

/**
 * Type-safe version of resolvePrefixToId that returns a typed FullEventId
 *
 * @param prefix - A ShortEventId (12-char hex prefix)
 * @returns A typed FullEventId, or null if not found
 */
export function resolvePrefixToFullEventId(prefix: ShortEventId): FullEventId | null {
    const resolved = resolvePrefixToId(prefix);
    if (resolved && isFullEventId(resolved)) {
        return resolved;
    }
    return null;
}

/**
 * Result type for normalizeLessonEventId - either success with eventId or error with message
 */
export type NormalizeLessonEventIdResult =
    | { success: true; eventId: string }
    | { success: false; error: string; errorType: "invalid_format" | "prefix_not_found" | "store_not_initialized" };

/**
 * Normalizes various lesson event ID formats to a canonical 64-char lowercase hex ID.
 *
 * Accepts:
 * - Full 64-character hex IDs
 * - 12-character hex prefixes (resolved via PrefixKVStore or in-memory fallback)
 * - NIP-19 formats: note1..., nevent1...
 * - nostr: prefixed versions of all the above
 *
 * This bridges the contract mismatch between lesson_learn (which emits NIP-19 encoded IDs)
 * and lesson_get (which needs hex IDs for lookup).
 *
 * @param input - The event ID in any supported format
 * @param allLessons - Optional array of all lessons for in-memory prefix fallback
 * @returns Result object with either normalized eventId or error details
 */
export function normalizeLessonEventId(
    input: string,
    allLessons?: NDKAgentLesson[]
): NormalizeLessonEventIdResult {
    const trimmed = input.trim();

    // Strip nostr: prefix if present
    const cleaned = trimmed.startsWith("nostr:") ? trimmed.slice(6) : trimmed;

    // 1. Check for full 64-char hex ID
    if (/^[0-9a-f]{64}$/i.test(cleaned)) {
        return { success: true, eventId: cleaned.toLowerCase() };
    }

    // 2. Check for 12-char hex prefix
    if (isHexPrefix(cleaned)) {
        const prefix = cleaned.toLowerCase();

        // Try PrefixKVStore first
        if (prefixKVStore.isInitialized()) {
            try {
                const resolved = prefixKVStore.lookup(prefix);
                if (resolved) {
                    return { success: true, eventId: resolved };
                }
            } catch (error) {
                console.debug("[normalizeLessonEventId] PrefixKVStore lookup error:", error);
                // Fall through to in-memory fallback
            }
        }

        // In-memory fallback: scan lessons for unique prefix match
        if (allLessons && allLessons.length > 0) {
            const matches = allLessons.filter((l) => l.id?.toLowerCase().startsWith(prefix));
            if (matches.length === 1 && matches[0].id) {
                return { success: true, eventId: matches[0].id.toLowerCase() };
            }
            if (matches.length > 1) {
                return {
                    success: false,
                    error: `Prefix "${input}" is ambiguous - matches ${matches.length} lessons. Use a longer prefix or full event ID.`,
                    errorType: "prefix_not_found",
                };
            }
        }

        // Distinguish between "store not initialized" vs "not found"
        if (!prefixKVStore.isInitialized()) {
            return {
                success: false,
                error: `Could not resolve prefix "${input}" - PrefixKVStore is not initialized and no in-memory matches found.`,
                errorType: "store_not_initialized",
            };
        }

        return {
            success: false,
            error: `Could not resolve prefix "${input}" to a full event ID. No matching lesson found.`,
            errorType: "prefix_not_found",
        };
    }

    // 3. Try NIP-19 decoding (note1..., nevent1...)
    try {
        const decoded = nip19.decode(cleaned);
        if (decoded.type === "note") {
            return { success: true, eventId: (decoded.data as string).toLowerCase() };
        }
        if (decoded.type === "nevent") {
            return { success: true, eventId: (decoded.data as { id: string }).id.toLowerCase() };
        }
        // Other NIP-19 types (npub, nprofile, naddr) are not valid event IDs
        return {
            success: false,
            error: `Invalid lesson event ID format: "${input}". Got NIP-19 type "${decoded.type}" but expected "note" or "nevent".`,
            errorType: "invalid_format",
        };
    } catch {
        // Not a valid NIP-19 format, fall through to error
    }

    // 4. Invalid format
    return {
        success: false,
        error: `Invalid lesson event ID format: "${input}". Expected 64-char hex, 12-char hex prefix, or NIP-19 (note1.../nevent1...).`,
        errorType: "invalid_format",
    };
}
