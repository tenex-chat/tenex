import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Extract all E-tags from an event
 */
export function getETags(event: NDKEvent): string[] {
    return event.tags
        .filter((tag) => tag[0] === "e")
        .map((tag) => tag[1])
        .filter((value): value is string => !!value);
}

/**
 * Extract the first E-tag value (commonly used for parent event reference)
 */
export function getFirstETag(event: NDKEvent): string | null {
    const eTags = getETags(event);
    return eTags.length > 0 ? eTags[0] : null;
}

/**
 * Extract all P-tags from an event
 */
export function getPTags(event: NDKEvent): string[] {
    return event.tags
        .filter((tag) => tag[0] === "p")
        .map((tag) => tag[1])
        .filter((value): value is string => !!value);
}

/**
 * Extract mentioned pubkeys from P-tags (alias for getPTags)
 */
export function getMentionedPubkeys(event: NDKEvent): string[] {
    return getPTags(event);
}

/**
 * Extract tool tags from an event
 */
export function getToolTags(event: NDKEvent): Array<{ name: string; args?: unknown }> {
    return event.tags
        .filter((tag) => tag[0] === "tool")
        .map((tag) => {
            const toolInfo: { name: string; args?: unknown } = { name: tag[1] };
            if (tag[2]) {
                try {
                    toolInfo.args = JSON.parse(tag[2]);
                } catch {
                    // Keep args as undefined if parsing fails
                }
            }
            return toolInfo;
        })
        .filter((tool): tool is { name: string; args?: unknown } => !!tool.name);
}

/**
 * Extract D-tag value (used for replaceable events)
 */
export function getDTag(event: NDKEvent): string | null {
    const dTag = event.tags.find((tag) => tag[0] === "d");
    return dTag?.[1] || null;
}

/**
 * Extract mode tags from an event
 */
export function getModeTags(event: NDKEvent): string[] {
    return event.tags
        .filter((tag) => tag[0] === "mode")
        .map((tag) => tag[1])
        .filter((value): value is string => !!value);
}

/**
 * Check if event has a specific mode tag
 */
export function hasMode(event: NDKEvent, mode: string): boolean {
    return getModeTags(event).includes(mode);
}

/**
 * Extract error type from error tags
 */
export function getErrorType(event: NDKEvent): string | null {
    const errorTag = event.tags.find((tag) => tag[0] === "error");
    return errorTag?.[1] || null;
}

/**
 * Extract participant pubkeys from participant tags
 */
export function getParticipants(event: NDKEvent): string[] {
    return event.tags
        .filter((tag) => tag[0] === "participant")
        .map((tag) => tag[1])
        .filter((value): value is string => !!value);
}

/**
 * Get all values for a specific tag type
 */
export function getTagValues(event: NDKEvent, tagType: string): string[] {
    return event.tags
        .filter((tag) => tag[0] === tagType)
        .map((tag) => tag[1])
        .filter((value): value is string => !!value);
}

/**
 * Get the first value for a specific tag type
 */
export function getTagValue(event: NDKEvent, tagType: string): string | null {
    const values = getTagValues(event, tagType);
    return values.length > 0 ? values[0] : null;
}
