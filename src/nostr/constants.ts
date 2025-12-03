/**
 * Nostr event kinds used in the application
 */
export enum NostrKind {
    // Standard kinds
    TEXT_NOTE = 1,
    REACTION = 7,

    // Custom application kinds
    BRAINSTORM_REQUEST = 11,
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
    BRAINSTORM_SELECTION = "brainstorm-selection",
    REASON = "reason",
    TOOL = "tool",
    NOT_CHOSEN = "not-chosen", // Legacy - to be removed
}

/**
 * Tag values for specific application modes
 */
export enum TagValue {
    BRAINSTORM_MODE = "brainstorm",
    REACTION_POSITIVE = "+",
    DELEGATE_PHASE = "delegate_phase",
}

/**
 * Maximum lengths for various fields
 */
export const MAX_REASON_LENGTH = 200;

/**
 * Type guard to check if an event is a brainstorm event
 */
export function isBrainstormEvent(kind: number, tags: string[][]): boolean {
    return (
        kind === NostrKind.BRAINSTORM_REQUEST &&
        tags.some((tag) => tag[0] === NostrTag.MODE && tag[1] === TagValue.BRAINSTORM_MODE)
    );
}
