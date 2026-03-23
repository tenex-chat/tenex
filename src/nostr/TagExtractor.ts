import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Extract all a-tags from an event
 */
export function getATags(event: NDKEvent): string[] {
    return event.tags
        .filter((tag) => tag[0] === "a")
        .map((tag) => tag[1])
        .filter((value): value is string => !!value);
}

/**
 * Extract project-specific A-tags (those starting with "31933:")
 */
export function getProjectATags(event: NDKEvent): string[] {
    return getATags(event).filter((tag) => tag.startsWith("31933:"));
}

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
 * Extract K-tags (kind tags) from an event
 */
export function getKTags(event: NDKEvent): string[] {
    return event.tags
        .filter((tag) => tag[0] === "k")
        .map((tag) => tag[1])
        .filter((value): value is string => !!value);
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
 * Extract nudge tags from an event
 */
export function getNudgeTags(event: NDKEvent): string[] {
    return event.tags
        .filter((tag) => tag[0] === "nudge")
        .map((tag) => tag[1])
        .filter((value): value is string => !!value);
}

/**
 * Extract error type from error tags
 */
export function getErrorType(event: NDKEvent): string | null {
    const errorTag = event.tags.find((tag) => tag[0] === "error");
    return errorTag?.[1] || null;
}

/**
 * Extract moderator from moderator tags
 */
export function getModerator(event: NDKEvent): string | null {
    const modTag = event.tags.find((tag) => tag[0] === "moderator");
    return modTag?.[1] || null;
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
 * Extract trace context from an event (for telemetry)
 */
export function getTraceContext(event: NDKEvent): string | null {
    const traceTag = event.tags.find((tag) => tag[0] === "trace_context");
    return traceTag?.[1] || null;
}

/**
 * Check if an event has any tags of a specific type
 */
export function hasTag(event: NDKEvent, tagType: string): boolean {
    return event.tags.some((tag) => tag[0] === tagType);
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
