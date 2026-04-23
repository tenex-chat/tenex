import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Get the event ID this event is replying to (if any).
 * Prefers the NIP-10 "root" marker; falls back to any e-tag for events without markers.
 */
export function getReplyTarget(event: NDKEvent): string | undefined {
    return event.tagValue("e", "root") ?? event.tagValue("e");
}

/**
 * Get mentioned pubkeys from event
 */
export function getMentionedPubkeys(event: NDKEvent): string[] {
    return event.tags
        .filter((tag) => tag[0] === "p")
        .map((tag) => tag[1])
        .filter((pubkey): pubkey is string => !!pubkey);
}

/**
 * Extract skill event IDs from event tags
 * Returns an array of event IDs from all ['skill', '<id>'] tags
 */
export function extractSkillEventIds(event: NDKEvent): string[] {
    return event.tags
        .filter((tag) => tag[0] === "skill")
        .map((tag) => tag[1])
        .filter((id): id is string => !!id);
}
