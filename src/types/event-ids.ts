/**
 * Typed Event IDs - Branded types for type-safe ID handling
 *
 * This module provides branded types to prevent bugs where functions receive
 * wrong ID formats. The three main ID categories are:
 *
 * 1. FullEventId (64-char hex) - Full Nostr event IDs and conversation IDs
 * 2. ShortEventId (12-char hex) - Shortened IDs for display and user input
 * 3. ShellTaskId (7-char alphanumeric) - Background shell task identifiers
 *
 * Usage:
 * ```typescript
 * // Create typed IDs
 * const fullId = createFullEventId("a1b2c3...");  // 64 chars
 * const shortId = createShortEventId("a1b2c3d4e5f6");  // 12 chars
 *
 * // Type guards
 * if (isFullEventId(input)) {
 *   // input is FullEventId
 * }
 *
 * // Conversion
 * const short = shortenEventId(fullId);  // FullEventId -> ShortEventId
 * ```
 */

// =============================================================================
// Branded Types
// =============================================================================

/**
 * 64-character lowercase hex string (Nostr event ID / conversation ID)
 *
 * This is the canonical format for:
 * - Nostr event IDs
 * - Conversation IDs
 * - Delegation IDs
 * - Agent pubkeys (technically different semantic, same format)
 */
export type FullEventId = string & { readonly __brand: "FullEventId" };

/**
 * 12-character lowercase hex string (shortened event ID for display)
 *
 * Used for:
 * - User-facing display (logs, UI, tool outputs)
 * - User input (when typing IDs manually)
 * - Prefix lookups via PrefixKVStore
 *
 * Provides 48 bits of entropy (2^48 ≈ 281 trillion combinations),
 * giving very low collision probability for typical conversation volumes.
 */
export type ShortEventId = string & { readonly __brand: "ShortEventId" };

/**
 * 7-character alphanumeric string (shell background task ID)
 *
 * Generated via Math.random().toString(36).substring(2, 9)
 * Used only for background shell task tracking (in-memory, per-process)
 */
export type ShellTaskId = string & { readonly __brand: "ShellTaskId" };

// =============================================================================
// Union Types
// =============================================================================

/**
 * Any event ID format (full or short)
 * Use when a function accepts either format and will resolve internally
 */
export type AnyEventId = FullEventId | ShortEventId;

/**
 * Any task/target ID format
 * Use for kill tool and similar commands that accept multiple ID types
 */
export type AnyTaskId = FullEventId | ShortEventId | ShellTaskId;

// =============================================================================
// Constants
// =============================================================================

/** Length of a full event ID (64 hex characters) */
export const FULL_EVENT_ID_LENGTH = 64;

/** Length of a short event ID prefix (12 hex characters) */
export const SHORT_EVENT_ID_LENGTH = 12;

/** Length of a shell task ID (7 alphanumeric characters) */
export const SHELL_TASK_ID_LENGTH = 7;

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a string is a valid full event ID format (64-char lowercase hex)
 */
export function isFullEventId(id: string): id is FullEventId {
    return /^[0-9a-f]{64}$/.test(id);
}

/**
 * Check if a string is a valid short event ID format (12-char lowercase hex)
 */
export function isShortEventId(id: string): id is ShortEventId {
    return /^[0-9a-f]{12}$/.test(id);
}

/**
 * Check if a string is a valid shell task ID format (7-char alphanumeric)
 */
export function isShellTaskId(id: string): id is ShellTaskId {
    return /^[a-z0-9]{7}$/.test(id);
}

/**
 * Detect the type of an ID string
 *
 * @returns The detected type, or null if the format is not recognized
 */
export function detectIdType(id: string): "full" | "short" | "shell" | null {
    const normalized = id.toLowerCase();

    if (isFullEventId(normalized)) {
        return "full";
    }

    if (isShortEventId(normalized)) {
        return "short";
    }

    if (isShellTaskId(normalized)) {
        return "shell";
    }

    return null;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a FullEventId from a string, with validation
 *
 * @throws Error if the input is not a valid 64-char hex string
 */
export function createFullEventId(id: string): FullEventId {
    const normalized = id.toLowerCase();

    if (!isFullEventId(normalized)) {
        throw new Error(
            `Invalid FullEventId: expected 64-char lowercase hex string, got "${id.substring(0, 20)}..." (length: ${id.length})`
        );
    }

    return normalized;
}

/**
 * Create a ShortEventId from a string, with validation
 *
 * @throws Error if the input is not a valid 12-char hex string
 */
export function createShortEventId(id: string): ShortEventId {
    const normalized = id.toLowerCase();

    if (!isShortEventId(normalized)) {
        throw new Error(
            `Invalid ShortEventId: expected 12-char lowercase hex string, got "${id}" (length: ${id.length})`
        );
    }

    return normalized;
}

/**
 * Create a ShellTaskId from a string, with validation
 *
 * @throws Error if the input is not a valid 7-char alphanumeric string
 */
export function createShellTaskId(id: string): ShellTaskId {
    const normalized = id.toLowerCase();

    if (!isShellTaskId(normalized)) {
        throw new Error(
            `Invalid ShellTaskId: expected 7-char lowercase alphanumeric string, got "${id}" (length: ${id.length})`
        );
    }

    return normalized;
}

/**
 * Attempt to create a FullEventId, returning null on failure instead of throwing
 */
export function tryCreateFullEventId(id: string): FullEventId | null {
    const normalized = id.toLowerCase();
    return isFullEventId(normalized) ? normalized : null;
}

/**
 * Attempt to create a ShortEventId, returning null on failure instead of throwing
 */
export function tryCreateShortEventId(id: string): ShortEventId | null {
    const normalized = id.toLowerCase();
    return isShortEventId(normalized) ? normalized : null;
}

/**
 * Attempt to create a ShellTaskId, returning null on failure instead of throwing
 */
export function tryCreateShellTaskId(id: string): ShellTaskId | null {
    const normalized = id.toLowerCase();
    return isShellTaskId(normalized) ? normalized : null;
}

// =============================================================================
// Conversion Functions
// =============================================================================

/**
 * Shorten a full event ID to a short event ID (first 12 characters)
 */
export function shortenEventId(fullId: FullEventId): ShortEventId {
    return fullId.substring(0, SHORT_EVENT_ID_LENGTH) as ShortEventId;
}

/**
 * Convert any typed ID back to a raw string
 * Useful for interfacing with external APIs that expect plain strings
 */
export function toRawString(id: AnyEventId | ShellTaskId): string {
    return id as string;
}

// =============================================================================
// Assertion Functions
// =============================================================================

/**
 * Assert that a string is a valid FullEventId (already lowercase)
 *
 * NOTE: This assertion is STRICT - it requires the string to already be
 * lowercase. If you have potentially uppercase input, use createFullEventId()
 * which normalizes and returns the typed ID.
 *
 * @throws Error if the assertion fails (not 64-char lowercase hex)
 */
export function assertFullEventId(id: string): asserts id is FullEventId {
    if (!isFullEventId(id)) {
        throw new Error(
            `Assertion failed: expected FullEventId (64-char lowercase hex), got "${id.substring(0, 20)}..." (length: ${id.length}). Use createFullEventId() to normalize uppercase input.`
        );
    }
}

/**
 * Assert that a string is a valid ShortEventId (already lowercase)
 *
 * NOTE: This assertion is STRICT - it requires the string to already be
 * lowercase. If you have potentially uppercase input, use createShortEventId()
 * which normalizes and returns the typed ID.
 *
 * @throws Error if the assertion fails (not 12-char lowercase hex)
 */
export function assertShortEventId(id: string): asserts id is ShortEventId {
    if (!isShortEventId(id)) {
        throw new Error(
            `Assertion failed: expected ShortEventId (12-char lowercase hex), got "${id}" (length: ${id.length}). Use createShortEventId() to normalize uppercase input.`
        );
    }
}

/**
 * Assert that a string is a valid ShellTaskId (already lowercase)
 *
 * NOTE: This assertion is STRICT - it requires the string to already be
 * lowercase. If you have potentially uppercase input, use createShellTaskId()
 * which normalizes and returns the typed ID.
 *
 * @throws Error if the assertion fails (not 7-char lowercase alphanumeric)
 */
export function assertShellTaskId(id: string): asserts id is ShellTaskId {
    if (!isShellTaskId(id)) {
        throw new Error(
            `Assertion failed: expected ShellTaskId (7-char lowercase alphanumeric), got "${id}" (length: ${id.length}). Use createShellTaskId() to normalize uppercase input.`
        );
    }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse an ID from user input, detecting its type
 *
 * @returns Object with typed ID and detected type, or null if unrecognized
 */
export function parseEventId(
    input: string
): { id: FullEventId; type: "full" } | { id: ShortEventId; type: "short" } | { id: ShellTaskId; type: "shell" } | null {
    const normalized = input.trim().toLowerCase();

    if (isFullEventId(normalized)) {
        return { id: normalized, type: "full" };
    }

    if (isShortEventId(normalized)) {
        return { id: normalized, type: "short" };
    }

    if (isShellTaskId(normalized)) {
        return { id: normalized, type: "shell" };
    }

    return null;
}
