import type { AgentInstance } from "@/agents/types";
import { NDKKind } from "@/nostr/kinds";
import { getProjectContext } from "@/services/projects";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * AgentEventDecoder - Utilities for decoding and analyzing Nostr events
 *
 * This class provides static methods for extracting information from Nostr events
 * and determining their types, targets, and relationships.
 */

// biome-ignore lint/complexity/noStaticOnlyClass: Static utility class for decoding event semantics
export class AgentEventDecoder {
    /**
     * Check if an event is directed to the system (project or agents)
     */
    static isDirectedToSystem(event: NDKEvent, systemAgents: Map<string, AgentInstance>): boolean {
        const pTags = event.tags.filter((tag) => tag[0] === "p");
        if (pTags.length === 0) return false;

        const mentionedPubkeys = pTags
            .map((tag) => tag[1])
            .filter((pubkey): pubkey is string => !!pubkey);

        const systemPubkeys = new Set([...Array.from(systemAgents.values()).map((a) => a.pubkey)]);

        // Add project manager pubkey if available
        const projectCtx = getProjectContext();
        if (projectCtx.projectManager?.pubkey) {
            systemPubkeys.add(projectCtx.projectManager.pubkey);
        }

        return mentionedPubkeys.some((pubkey) => systemPubkeys.has(pubkey));
    }

    /**
     * Check if event is from an agent in the system
     */
    static isEventFromAgent(event: NDKEvent, systemAgents: Map<string, AgentInstance>): boolean {
        const agentPubkeys = new Set(Array.from(systemAgents.values()).map((a) => a.pubkey));
        return agentPubkeys.has(event.pubkey);
    }

    /**
     * Get the event ID this event is replying to (if any).
     * For kind:1 events, this is the 'e' tag value.
     */
    static getReplyTarget(event: NDKEvent): string | undefined {
        return event.tagValue("e");
    }

    /**
     * Get mentioned pubkeys from event
     */
    static getMentionedPubkeys(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "p")
            .map((tag) => tag[1])
            .filter((pubkey): pubkey is string => !!pubkey);
    }

    /**
     * Check if this is an agent's internal message (completion, delegation, etc)
     */
    static isAgentInternalMessage(event: NDKEvent): boolean {
        // Events with tool tags are internal agent operations
        if (event.tagValue("tool")) {
            return true;
        }

        // Status events are internal
        if (event.tagValue("status")) {
            return true;
        }

        return false;
    }

    /**
     * Check if event is a delegation request (kind:1 from agent to agent)
     */
    static isDelegationRequest(
        event: NDKEvent,
        systemAgents?: Map<string, AgentInstance>
    ): boolean {
        if (event.kind !== 1) return false;

        // If we have system agents, verify it's from an agent
        if (systemAgents) {
            const isFromAgent = AgentEventDecoder.isEventFromAgent(event, systemAgents);
            if (!isFromAgent) return false;

            // Check if p-tag points to another agent
            const pTag = event.tagValue("p");
            if (pTag && Array.from(systemAgents.values()).some((a) => a.pubkey === pTag)) {
                return true;
            }
        } else {
            // Fallback: just check if it has a p-tag (less accurate)
            return !!event.tagValue("p");
        }

        return false;
    }

    /**
     * Check if event is a delegation completion (kind:1 with status:completed)
     */
    static isDelegationCompletion(event: NDKEvent): boolean {
        return event.kind === 1 && event.tagValue("status") === "completed";
    }

    /**
     * Get the delegation request ID from a completion event
     * Checks all e-tags to find the first valid delegation request ID
     */
    static getDelegationRequestId(event: NDKEvent): string | undefined {
        if (AgentEventDecoder.isDelegationCompletion(event)) {
            // Check all e-tags to find a delegation request ID
            // For explicit completions, we return the first e-tag as the most likely candidate
            // The DelegationCompletionHandler will validate if it's actually a tracked delegation
            const eTags = event.getMatchingTags("e");
            if (eTags.length > 0 && eTags[0][1]) {
                return eTags[0][1]; // Return the first e-tag value
            }
        }
        return undefined;
    }

    /**
     * Check if event is a status event
     */
    static isStatusEvent(event: NDKEvent): boolean {
        return event.kind === NDKKind.TenexProjectStatus;
    }

    /**
     * Extract error type from error event
     */
    static getErrorType(event: NDKEvent): string | undefined {
        return event.tagValue("error");
    }

    /**
     * Check if event has a specific tool tag
     */
    static hasTool(event: NDKEvent, toolName: string): boolean {
        return event.tagValue("tool") === toolName;
    }

    /**
     * Get all tool tags from event
     */
    static getToolTags(event: NDKEvent): Array<{ name: string; args?: unknown }> {
        return event.tags
            .filter((tag) => tag[0] === "tool")
            .map((tag) => ({
                name: tag[1],
                args: tag[2] ? JSON.parse(tag[2]) : undefined,
            }));
    }

    /**
     * Get participant pubkeys from an event
     * Participants are specified in "participant" tags
     */
    static getParticipants(event: NDKEvent): string[] {
        // Get all participant tags
        const participantTags = event.tags.filter((tag) => tag[0] === "participant");
        return participantTags.map((tag) => tag[1]).filter((pubkey) => !!pubkey);
    }

    /**
     * Extract nudge event IDs from event tags
     * Returns an array of event IDs from all ['nudge', '<id>'] tags
     */
    static extractNudgeEventIds(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "nudge")
            .map((tag) => tag[1])
            .filter((id): id is string => !!id);
    }

    /**
     * Extract skill event IDs from event tags
     * Returns an array of event IDs from all ['skill', '<id>'] tags
     */
    static extractSkillEventIds(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "skill")
            .map((tag) => tag[1])
            .filter((id): id is string => !!id);
    }

    // ============================================================================
    // Daemon-specific event classification methods
    // These are used by the daemon for routing and filtering decisions
    // ============================================================================

    /**
     * Event kinds that should never be routed to projects.
     * These events are informational or transient and don't require processing.
     * - kind:0 (Metadata) and kind:3 (Contacts) are global identity events
     * - Status events are daemon-level only
     */
    private static readonly NEVER_ROUTE_EVENT_KINDS = [
        NDKKind.Metadata, // kind:0 - user profile metadata
        NDKKind.Contacts, // kind:3 - contact list
        NDKKind.TenexProjectStatus,
        NDKKind.TenexOperationsStatus,
    ];

    /**
     * Check if an event kind should never be routed to projects
     * @param event - The event to check
     * @returns True if the event should not be routed
     */
    static isNeverRouteKind(event: NDKEvent): boolean {
        return event.kind !== undefined && this.NEVER_ROUTE_EVENT_KINDS.includes(event.kind);
    }

    /**
     * Check if this is a project event (kind 31933)
     * @param event - The event to check
     * @returns True if this is a project creation/update event
     */
    static isProjectEvent(event: NDKEvent): boolean {
        return event.kind === 31933;
    }

    /**
     * Check if this is a lesson event (kind 4129)
     * @param event - The event to check
     * @returns True if this is an agent lesson event
     */
    static isLessonEvent(event: NDKEvent): boolean {
        return event.kind === NDKKind.AgentLesson;
    }

    /**
     * Extract project ID from a project event
     * Format: "31933:authorPubkey:dTag"
     * @param event - Project event (kind 31933)
     * @returns Project ID string or null if not a valid project event
     */
    static extractProjectId(event: NDKEvent): string | null {
        if (!this.isProjectEvent(event)) {
            return null;
        }

        const dTag = event.tags.find((t) => t[0] === "d")?.[1];
        if (!dTag) {
            return null;
        }

        return `31933:${event.pubkey}:${dTag}`;
    }

    /**
     * Extract agent definition ID from a lesson event
     * @param event - Lesson event (kind 4129)
     * @returns Agent definition event ID or null
     */
    static extractAgentDefinitionIdFromLesson(event: NDKEvent): string | null {
        if (!this.isLessonEvent(event)) {
            return null;
        }

        // Lesson events reference agent definitions via e-tag
        const eTag = event.tags.find((t) => t[0] === "e")?.[1];
        return eTag || null;
    }

    /**
     * Check if event has project A-tags
     * @param event - The event to check
     * @returns True if event has A-tags referencing projects (31933:...)
     */
    static hasProjectATags(event: NDKEvent): boolean {
        const aTags = event.tags.filter((t) => t[0] === "A" || t[0] === "a");
        return aTags.some((t) => t[1]?.startsWith("31933:"));
    }

    /**
     * Extract project A-tags from an event
     * @param event - The event to analyze
     * @returns Array of project IDs from A-tags
     */
    static extractProjectATags(event: NDKEvent): string[] {
        const aTags = event.tags.filter((t) => t[0] === "A" || t[0] === "a");
        return aTags
            .filter((t) => t[1]?.startsWith("31933:"))
            .map((t) => t[1])
            .filter((id): id is string => !!id);
    }

    /**
     * Classify event type for daemon routing
     * @param event - The event to classify
     * @returns Event classification for routing decisions
     */
    static classifyForDaemon(
        event: NDKEvent
    ): "never_route" | "project" | "lesson" | "lesson_comment" | "conversation" | "boot" | "unknown" {
        if (this.isNeverRouteKind(event)) return "never_route";
        if (this.isProjectEvent(event)) return "project";
        if (this.isLessonEvent(event)) return "lesson";
        if (this.isLessonCommentEvent(event)) return "lesson_comment";
        if (event.kind === NDKKind.Text) {
            return "conversation";
        }
        if (event.kind === NDKKind.TenexBootProject) {
            return "boot";
        }
        return "unknown";
    }

    /**
     * Check if an event is a lesson comment (kind NDKKind.Comment with #K: [NDKKind.AgentLesson])
     * @param event - The event to check
     * @returns True if this is a lesson comment event
     */
    static isLessonCommentEvent(event: NDKEvent): boolean {
        if (event.kind !== NDKKind.Comment) return false;
        // NIP-22: #K tag indicates the kind of the root event
        const kTag = event.tagValue("K");
        return kTag === String(NDKKind.AgentLesson); // Comments on lessons
    }

    /**
     * Check if an event is a config update
     * @param event - The event to check
     * @returns True if this is a config update event
     */
    static isConfigUpdate(event: NDKEvent): boolean {
        return event.kind === NDKKind.TenexAgentConfigUpdate;
    }

    /**
     * Check if an event is a metadata event
     * @param event - The event to check
     * @returns True if this is a metadata event
     */
    static isMetadata(event: NDKEvent): boolean {
        return event.kind === NDKKind.Metadata;
    }

    /**
     * Check if an event is a stop command
     * @param event - The event to check
     * @returns True if this is a stop command event
     */
    static isStopCommand(event: NDKEvent): boolean {
        return event.kind === NDKKind.TenexStopCommand;
    }
}
