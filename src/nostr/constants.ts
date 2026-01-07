/**
 * Nostr event kinds used in the application
 */
export enum NostrKind {
    // Standard kinds
    TEXT_NOTE = 1,
    REACTION = 7,
    ARTICLE = 30023,
}

/**
 * Standard Nostr tag names
 */
export enum NostrTag {
    // Standard tags
    EVENT = "e",
    PUBKEY = "p",
    REPLACEABLE = "a",

    // Application-specific tags
    MODE = "mode",
    PARTICIPANT = "participant",
    REASON = "reason",
    TOOL = "tool",
}

/**
 * Tag values for specific application modes
 */
export enum TagValue {
    REACTION_POSITIVE = "+",
    DELEGATE = "delegate",
}

/**
 * Maximum lengths for various fields
 */
export const MAX_REASON_LENGTH = 200;
