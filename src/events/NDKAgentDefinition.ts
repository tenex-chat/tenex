import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, type NDKRawEvent } from "@nostr-dev-kit/ndk";

export class NDKAgentDefinition extends NDKEvent {
    static kind = 4199;
    static kinds = [4199];

    constructor(ndk?: NDK, event?: NDKEvent | NDKRawEvent) {
        super(ndk, event);
        this.kind ??= 4199;
    }

    static from(event: NDKEvent): NDKAgentDefinition {
        return new NDKAgentDefinition(event.ndk, event);
    }

    get name(): string | undefined {
        return this.tagValue("title");
    }

    set name(value: string | undefined) {
        this.removeTag("title");
        if (value) this.tags.push(["title", value]);
    }

    get title(): string | undefined {
        return this.tagValue("title");
    }

    set title(value: string | undefined) {
        this.removeTag("title");
        if (value) this.tags.push(["title", value]);
    }

    get description(): string | undefined {
        return this.tagValue("description");
    }

    /**
     * A one-liner description of the agent's purpose or functionality.
     */
    set description(value: string | undefined) {
        this.removeTag("description");
        if (value) this.tags.push(["description", value]);
    }

    /**
     * Extended markdown description from the event content field.
     * MAY contain markdown-formatted extended description of the agent.
     */
    get markdownDescription(): string | undefined {
        return this.content || undefined;
    }

    /**
     * Set the extended markdown description in the event content field.
     */
    set markdownDescription(value: string | undefined) {
        this.content = value || "";
    }

    get role(): string | undefined {
        return this.tagValue("role");
    }

    /**
     * The expertise and personality for this agent.
     * This shapes how the agent interacts with users and other agents.
     */
    set role(value: string | undefined) {
        this.removeTag("role");
        if (value) this.tags.push(["role", value]);
    }

    get instructions(): string | undefined {
        return this.tagValue("instructions");
    }

    /**
     * Detailed instructions or guidelines for the agent's operation.
     */
    set instructions(value: string | undefined) {
        this.removeTag("instructions");
        if (value) this.tags.push(["instructions", value]);
    }

    get version(): number {
        const val = this.tagValue("ver");
        if (val === undefined) return 1; // Default version if not specified
        return Number.parseInt(val, 10);
    }

    set version(value: number) {
        this.removeTag("ver");
        this.tags.push(["ver", value.toString()]);
    }

    get useCriteria(): string | undefined {
        return this.tagValue("use-criteria");
    }

    /**
     * Criteria for when this agent should be selected or used.
     * This helps with agent routing and selection.
     */
    set useCriteria(value: string | undefined) {
        this.removeTag("use-criteria");
        if (value) this.tags.push(["use-criteria", value]);
    }

    get category(): string | undefined {
        return this.tagValue("category");
    }

    /**
     * Category for the agent (e.g., 'developer', 'analyst', 'assistant').
     */
    set category(value: string | undefined) {
        this.removeTag("category");
        if (value) this.tags.push(["category", value]);
    }

    get slug(): string | undefined {
        return this.tagValue("d");
    }

    /**
     * The slug identifier for this agent definition.
     * This is used to find different versions from the same author of the same agent
     * (e.g., version 1, 2, 3 of a 'human-replica' agent would all share ["d", "human-replica"]).
     *
     * Note: We use direct tag mutation instead of replaceTag() because replaceTag()
     * always adds a tag, but we need to support clearing the slug (setting undefined).
     */
    set slug(value: string | undefined) {
        this.removeTag("d");
        if (value !== undefined) this.tags.push(["d", value]);
    }

    /**
     * Get script e-tags from the agent definition.
     * Script e-tags reference kind 1063 (NIP-94 file metadata) events
     * that contain files bundled with the agent.
     *
     * @returns Array of objects with eventId and optional relayUrl
     * @deprecated Use getFileETags() instead, which returns all e-tags (not just "script" marker)
     */
    getScriptETags(): Array<{ eventId: string; relayUrl?: string }> {
        const scriptTags = this.tags.filter((tag) => tag[0] === "e" && tag[3] === "script");
        const result: Array<{ eventId: string; relayUrl?: string }> = [];

        for (const tag of scriptTags) {
            const eventId = tag[1];
            if (eventId) {
                result.push({
                    eventId,
                    relayUrl: tag[2] || undefined,
                });
            }
        }

        return result;
    }

    /**
     * Get all e-tags from the agent definition.
     * E-tags may reference kind 1063 (NIP-94 file metadata) events
     * that contain files bundled with the agent, or other related events.
     *
     * Unlike getScriptETags(), this method returns ALL e-tags, not just
     * those with a specific marker, allowing for general event references.
     *
     * @returns Array of objects with eventId, optional relayUrl, and optional marker
     */
    getETags(): Array<{ eventId: string; relayUrl?: string; marker?: string }> {
        const eTags = this.tags.filter((tag) => tag[0] === "e" && tag[1]);
        const result: Array<{ eventId: string; relayUrl?: string; marker?: string }> = [];

        for (const tag of eTags) {
            result.push({
                eventId: tag[1],
                relayUrl: tag[2] || undefined,
                marker: tag[3] || undefined,
            });
        }

        return result;
    }

    /**
     * Get e-tags with the "file" marker.
     * These reference kind 1063 (NIP-94 file metadata) events that contain
     * files bundled with this agent definition.
     *
     * @returns Array of objects with eventId and optional relayUrl
     */
    getFileETags(): Array<{ eventId: string; relayUrl?: string }> {
        return this.tags
            .filter((tag) => tag[0] === "e" && tag[1] && tag[3] === "file")
            .map((tag) => ({
                eventId: tag[1],
                relayUrl: tag[2] || undefined,
            }));
    }

    /**
     * Get e-tags with the "fork" marker.
     * These reference the source kind 4199 agent definition event that
     * this agent was forked from.
     *
     * @returns Array of objects with eventId and optional relayUrl
     */
    getForkETags(): Array<{ eventId: string; relayUrl?: string }> {
        return this.tags
            .filter((tag) => tag[0] === "e" && tag[1] && tag[3] === "fork")
            .map((tag) => ({
                eventId: tag[1],
                relayUrl: tag[2] || undefined,
            }));
    }

    /**
     * Get the source agent definition this was forked from (if any).
     * Returns the first fork e-tag, or undefined if this is not a fork.
     *
     * @returns Object with eventId and optional relayUrl, or undefined
     */
    getForkSource(): { eventId: string; relayUrl?: string } | undefined {
        const forks = this.getForkETags();
        return forks.length > 0 ? forks[0] : undefined;
    }

    /**
     * Add a file reference e-tag with the "file" marker.
     * References a kind 1063 (NIP-94 file metadata) event.
     *
     * @param eventId - The event ID of the kind 1063 file metadata event
     * @param relayUrl - Optional relay hint URL
     */
    addFileReference(eventId: string, relayUrl?: string): void {
        this.tags.push(this.buildETag(eventId, relayUrl, "file"));
    }

    /**
     * Set the fork source for this agent definition.
     * Removes any existing fork e-tags and adds a new one.
     *
     * @param eventId - The event ID of the source kind 4199 agent definition
     * @param relayUrl - Optional relay hint URL
     */
    setForkSource(eventId: string, relayUrl?: string): void {
        // Remove existing fork tags
        this.tags = this.tags.filter((tag) => !(tag[0] === "e" && tag[3] === "fork"));

        // Add new fork tag
        this.tags.push(this.buildETag(eventId, relayUrl, "fork"));
    }

    /**
     * Build an e-tag array with the standard format: ["e", eventId, relayUrl, marker]
     *
     * @param eventId - The event ID to reference
     * @param relayUrl - Optional relay hint URL (defaults to empty string if not provided)
     * @param marker - The marker for the e-tag (e.g., "file", "fork", "script")
     * @returns The constructed e-tag array
     */
    private buildETag(eventId: string, relayUrl: string | undefined, marker: string): string[] {
        return ["e", eventId, relayUrl || "", marker];
    }
}
