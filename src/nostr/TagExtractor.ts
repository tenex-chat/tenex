import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Get all values for a specific tag type
 */
export function getTagValues(event: NDKEvent, tagType: string): string[] {
    return event.tags
        .filter((tag) => tag[0] === tagType)
        .map((tag) => tag[1])
        .filter((value): value is string => !!value);
}
