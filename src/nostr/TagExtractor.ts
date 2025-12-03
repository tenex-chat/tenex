import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Utility class for extracting and processing Nostr event tags.
 * Consolidates tag extraction logic scattered across the codebase.
 *
 * This class provides a single source of truth for tag extraction,
 * replacing 20+ instances of manual tag filtering across files.
 */
export class TagExtractor {
    /**
     * Extract all A-tags from an event (both uppercase and lowercase)
     * @param event - The event to extract A-tags from
     * @returns Array of A-tag values
     */
    static getATags(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "A" || tag[0] === "a")
            .map((tag) => tag[1])
            .filter((value): value is string => !!value);
    }

    /**
     * Extract project-specific A-tags (those starting with "31933:")
     * @param event - The event to extract project A-tags from
     * @returns Array of project A-tag values
     */
    static getProjectATags(event: NDKEvent): string[] {
        return this.getATags(event).filter((tag) => tag.startsWith("31933:"));
    }

    /**
     * Extract all E-tags from an event
     * @param event - The event to extract E-tags from
     * @returns Array of E-tag values (event IDs)
     */
    static getETags(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "e")
            .map((tag) => tag[1])
            .filter((value): value is string => !!value);
    }

    /**
     * Extract the first E-tag value (commonly used for parent event reference)
     * @param event - The event to extract E-tag from
     * @returns The first E-tag value or null
     */
    static getFirstETag(event: NDKEvent): string | null {
        const eTags = this.getETags(event);
        return eTags.length > 0 ? eTags[0] : null;
    }

    /**
     * Extract all P-tags from an event
     * @param event - The event to extract P-tags from
     * @returns Array of P-tag values (pubkeys)
     */
    static getPTags(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "p")
            .map((tag) => tag[1])
            .filter((value): value is string => !!value);
    }

    /**
     * Extract mentioned pubkeys from P-tags (alias for getPTags)
     * @param event - The event to extract mentioned pubkeys from
     * @returns Array of mentioned pubkeys
     */
    static getMentionedPubkeys(event: NDKEvent): string[] {
        return this.getPTags(event);
    }

    /**
     * Extract tool tags from an event
     * @param event - The event to extract tool tags from
     * @returns Array of tool tag objects with name and args
     */
    static getToolTags(event: NDKEvent): Array<{ name: string; args?: unknown }> {
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
     * @param event - The event to extract D-tag from
     * @returns The D-tag value or null
     */
    static getDTag(event: NDKEvent): string | null {
        const dTag = event.tags.find((tag) => tag[0] === "d");
        return dTag?.[1] || null;
    }

    /**
     * Extract K-tags (kind tags) from an event
     * @param event - The event to extract K-tags from
     * @returns Array of K-tag values (kind numbers as strings)
     */
    static getKTags(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "k")
            .map((tag) => tag[1])
            .filter((value): value is string => !!value);
    }

    /**
     * Extract mode tags from an event
     * @param event - The event to extract mode tags from
     * @returns Array of mode tag values
     */
    static getModeTags(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "mode")
            .map((tag) => tag[1])
            .filter((value): value is string => !!value);
    }

    /**
     * Check if event has a specific mode tag
     * @param event - The event to check
     * @param mode - The mode to check for
     * @returns True if the event has the specified mode tag
     */
    static hasMode(event: NDKEvent, mode: string): boolean {
        return this.getModeTags(event).includes(mode);
    }

    /**
     * Extract phase tags from an event
     * @param event - The event to extract phase tags from
     * @returns Array of phase tag values
     */
    static getPhaseTags(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "phase")
            .map((tag) => tag[1])
            .filter((value): value is string => !!value);
    }

    /**
     * Get the first phase tag value
     * @param event - The event to extract phase from
     * @returns The first phase tag value or null
     */
    static getPhase(event: NDKEvent): string | null {
        const phases = this.getPhaseTags(event);
        return phases.length > 0 ? phases[0] : null;
    }

    /**
     * Extract nudge tags from an event
     * @param event - The event to extract nudge tags from
     * @returns Array of nudge event IDs
     */
    static getNudgeTags(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "nudge")
            .map((tag) => tag[1])
            .filter((value): value is string => !!value);
    }

    /**
     * Extract error type from error tags
     * @param event - The event to extract error type from
     * @returns The error type or null
     */
    static getErrorType(event: NDKEvent): string | null {
        const errorTag = event.tags.find((tag) => tag[0] === "error");
        return errorTag?.[1] || null;
    }

    /**
     * Extract moderator from moderator tags
     * @param event - The event to extract moderator from
     * @returns The moderator pubkey or null
     */
    static getModerator(event: NDKEvent): string | null {
        const modTag = event.tags.find((tag) => tag[0] === "moderator");
        return modTag?.[1] || null;
    }

    /**
     * Extract participant pubkeys from participant tags
     * @param event - The event to extract participants from
     * @returns Array of participant pubkeys
     */
    static getParticipants(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "participant")
            .map((tag) => tag[1])
            .filter((value): value is string => !!value);
    }

    /**
     * Extract trace context from an event (for telemetry)
     * @param event - The event to extract trace context from
     * @returns The trace context value or null
     */
    static getTraceContext(event: NDKEvent): string | null {
        const traceTag = event.tags.find((tag) => tag[0] === "trace_context");
        return traceTag?.[1] || null;
    }

    /**
     * Check if an event has any tags of a specific type
     * @param event - The event to check
     * @param tagType - The tag type to check for
     * @returns True if the event has at least one tag of the specified type
     */
    static hasTag(event: NDKEvent, tagType: string): boolean {
        return event.tags.some((tag) => tag[0] === tagType);
    }

    /**
     * Get all values for a specific tag type
     * @param event - The event to extract tag values from
     * @param tagType - The tag type to extract
     * @returns Array of tag values
     */
    static getTagValues(event: NDKEvent, tagType: string): string[] {
        return event.tags
            .filter((tag) => tag[0] === tagType)
            .map((tag) => tag[1])
            .filter((value): value is string => !!value);
    }

    /**
     * Get the first value for a specific tag type
     * @param event - The event to extract tag value from
     * @param tagType - The tag type to extract
     * @returns The first tag value or null
     */
    static getTagValue(event: NDKEvent, tagType: string): string | null {
        const values = this.getTagValues(event, tagType);
        return values.length > 0 ? values[0] : null;
    }
}