import type { AgentInstance } from "@/agents/types";
import { NDKKind } from "@/nostr/kinds";
import { getProjectContext } from "@/services/ProjectContext";
import { type NDKEvent, NDKTask } from "@nostr-dev-kit/ndk";
import { TagExtractor } from "./TagExtractor";

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

        // Add project pubkey if available
        const projectCtx = getProjectContext();
        if (projectCtx.pubkey) {
            systemPubkeys.add(projectCtx.pubkey);
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
     * Check if this is a task completion event (for NDKTask kind:1934)
     * Note: This is different from delegation completions (kind:1111)
     */
    static isTaskCompletionEvent(event: NDKEvent): boolean {
        // Only for actual NDKTask completions, not delegations
        if (
            event.tagValue("K") === NDKTask.kind.toString() &&
            event.tagValue("P") === event.tagValue("p")
        ) {
            return true;
        }

        return false;
    }

    /**
     * Get conversation root from event
     */
    static getConversationRoot(event: NDKEvent): string | undefined {
        return event.tagValue("E") || event.tagValue("A");
    }

    /**
     * Check if event is an orphaned reply (reply without findable root)
     */
    static isOrphanedReply(event: NDKEvent): boolean {
        // Must be a kind 11 (text note reply)
        if (event.tagValue("K") !== "11") {
            return false;
        }

        // Must have a conversation root reference
        const hasRoot = !!(event.tagValue("E") || event.tagValue("A"));

        // Must have p-tags (directed to someone)
        const hasPTags = event.tags.some((tag) => tag[0] === "p");

        return hasRoot && hasPTags;
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
     * Extract phase from event if present
     */
    static getPhase(event: NDKEvent): string | undefined {
        return event.tagValue("phase");
    }

    /**
     * Check if event is a delegation request (kind:1111 from agent to agent)
     */
    static isDelegationRequest(
        event: NDKEvent,
        systemAgents?: Map<string, AgentInstance>
    ): boolean {
        // Must be kind:1111
        if (event.kind !== 1111) return false;

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
     * Check if event is a delegation completion (kind:1111 with tool:complete)
     */
    static isDelegationCompletion(event: NDKEvent): boolean {
        return event.kind === 1111 && event.tagValue("status") === "completed";
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
     * Get the K tag value (referenced event kind)
     */
    static getReferencedKind(event: NDKEvent): string | undefined {
        return event.tagValue("K");
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
     * Check if this is a streaming event
     */
    static isStreamingEvent(event: NDKEvent): boolean {
        return event.kind === NDKKind.TenexStreamingResponse;
    }

    /**
     * Get moderator pubkey from a kind:11 brainstorm event
     * The moderator is specified in the first p-tag
     */
    static getModerator(event: NDKEvent): string | null {
        if (event.kind !== 11) return null;

        // The moderator is the first p-tag
        const pTag = event.tagValue("p");
        return pTag || null;
    }

    /**
     * Get participant pubkeys from a brainstorm event
     * Participants are specified in "participant" tags
     * Works for both kind:11 (initial) and kind:1111 (follow-up) events
     */
    static getParticipants(event: NDKEvent): string[] {
        // Get all participant tags regardless of event kind
        // This supports both initial brainstorm (kind 11) and follow-ups (kind 1111)
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

    // ============================================================================
    // Daemon-specific event classification methods
    // These are used by the daemon for routing and filtering decisions
    // ============================================================================

    /**
     * Event kinds that should never be routed to projects.
     * These events are informational or transient and don't require processing.
     */
    private static readonly NEVER_ROUTE_EVENT_KINDS = [
        NDKKind.TenexProjectStatus,
        NDKKind.TenexStreamingResponse,
        NDKKind.TenexAgentTypingStart,
        NDKKind.TenexAgentTypingStop,
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
    ): "never_route" | "project" | "lesson" | "conversation" | "unknown" {
        if (this.isNeverRouteKind(event)) return "never_route";
        if (this.isProjectEvent(event)) return "project";
        if (this.isLessonEvent(event)) return "lesson";
        if (event.kind === NDKKind.GenericReply || event.kind === NDKKind.Thread) {
            return "conversation";
        }
        return "unknown";
    }

    /**
     * Check if an event is a brainstorm event
     * @param event - The event to check
     * @returns True if this is a brainstorm event (kind 11 with mode=brainstorm)
     */
    static isBrainstormEvent(event: NDKEvent): boolean {
        if (event.kind !== 11) return false;
        return TagExtractor.hasMode(event, "brainstorm");
    }

    /**
     * Check if an event is a conversation root
     * @param event - The event to check
     * @returns True if this is a conversation root event
     */
    static isConversationRoot(event: NDKEvent): boolean {
        return event.kind === NDKKind.ConversationRoot;
    }

    /**
     * Check if an event is a thread event
     * @param event - The event to check
     * @returns True if this is a thread event
     */
    static isThreadEvent(event: NDKEvent): boolean {
        return event.kind === NDKKind.Thread;
    }

    /**
     * Check if an event is a generic reply
     * @param event - The event to check
     * @returns True if this is a generic reply event
     */
    static isGenericReply(event: NDKEvent): boolean {
        return event.kind === NDKKind.GenericReply;
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
