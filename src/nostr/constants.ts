/**
 * Nostr event kinds used in the application
 */
export enum NostrKind {
    // Standard kinds
    TEXT_NOTE = 1,
    REACTION = 7,

    // Custom application kinds
    GENERIC_REPLY = 1111,
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

    // Extended tags (uppercase convention for root references)
    ROOT_EVENT = "E",
    ROOT_KIND = "K",
    ROOT_PUBKEY = "P",

    // Application-specific tags
    MODE = "mode",
    PARTICIPANT = "participant",
    PHASE = "phase",
    PHASE_INSTRUCTIONS = "phase-instructions",
    REASON = "reason",
    TOOL = "tool",
    NOT_CHOSEN = "not-chosen", // Legacy - to be removed
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
