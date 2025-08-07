import { NDKEvent, NDKTag } from "@nostr-dev-kit/ndk";
import type { Project } from "@/services/ConfigService";
import type { Phase } from "@/conversations/phases";

/**
 * Centralized Nostr event tagging utilities
 * Provides consistent tagging across all event publishers
 */

/**
 * Add project context tags to an event
 */
export function addProjectContextTags(event: NDKEvent, project: Project): void {
    // Add project tag
    event.tag(["project", project.pubkey]);
    
    // Add project name if available
    if (project.name) {
        event.tag(["project-name", project.name]);
    }
}

/**
 * Add conversation reference tags to an event
 */
export function addConversationTags(
    event: NDKEvent, 
    conversationId: string,
    phase?: Phase
): void {
    // Add conversation ID tag
    event.tag(["conversation", conversationId]);
    
    // Add phase tag if provided
    if (phase) {
        event.tag(["phase", phase]);
    }
}

/**
 * Add agent assignment tags (p tags) to an event
 */
export function addAgentAssignmentTags(
    event: NDKEvent, 
    agentPubkeys: string | string[]
): void {
    const pubkeys = Array.isArray(agentPubkeys) ? agentPubkeys : [agentPubkeys];
    
    for (const pubkey of pubkeys) {
        if (pubkey && pubkey.length > 0) {
            event.tag(["p", pubkey]);
        }
    }
}

/**
 * Clean unwanted default tags from an event
 * Useful for removing auto-added NDK tags
 */
export function cleanEventTags(
    event: NDKEvent, 
    tagsToClean: string[] = ["p", "e", "a"]
): void {
    event.tags = event.tags.filter(tag => !tagsToClean.includes(tag[0]));
}

/**
 * Add execution metadata tags to an event
 */
export function addExecutionMetadataTags(
    event: NDKEvent,
    metadata: {
        executionTime?: number;
        voiceMode?: boolean;
        branch?: string;
    }
): void {
    if (metadata.executionTime !== undefined) {
        event.tag(["execution-time", metadata.executionTime.toString()]);
    }
    
    if (metadata.voiceMode !== undefined) {
        event.tag(["voice-mode", metadata.voiceMode.toString()]);
    }
    
    if (metadata.branch) {
        event.tag(["branch", metadata.branch]);
    }
}

/**
 * Replace or add an E tag (event reference) to an event
 * Useful for creating proper reply chains
 */
export function setEventReferenceTags(
    event: NDKEvent,
    referencedEventId: string,
    relayUrl?: string,
    marker?: "root" | "reply" | "mention"
): void {
    // Remove existing E tags
    event.tags = event.tags.filter(tag => tag[0] !== "e");
    
    // Build the E tag
    const eTag: NDKTag = ["e", referencedEventId];
    
    if (relayUrl) {
        eTag.push(relayUrl);
    }
    
    if (marker) {
        // If no relay URL but we have a marker, add empty relay URL
        if (!relayUrl) {
            eTag.push("");
        }
        eTag.push(marker);
    }
    
    event.tag(eTag);
}

/**
 * Add tool execution tags to an event
 */
export function addToolExecutionTags(
    event: NDKEvent,
    toolName: string,
    status: "starting" | "running" | "completed" | "failed",
    duration?: number
): void {
    event.tag(["tool", toolName]);
    event.tag(["tool-status", status]);
    
    if (duration !== undefined) {
        event.tag(["tool-duration", duration.toString()]);
    }
}

/**
 * Filter out duplicate tags while preserving order
 * Useful for cleaning up events before publishing
 */
export function deduplicateTags(event: NDKEvent): void {
    const seen = new Set<string>();
    const uniqueTags: NDKTag[] = [];
    
    for (const tag of event.tags) {
        const tagKey = JSON.stringify(tag);
        if (!seen.has(tagKey)) {
            seen.add(tagKey);
            uniqueTags.push(tag);
        }
    }
    
    event.tags = uniqueTags;
}

/**
 * Get all tags of a specific type from an event
 */
export function getTagsByType(event: NDKEvent, tagType: string): NDKTag[] {
    return event.tags.filter(tag => tag[0] === tagType);
}

/**
 * Get the first tag value of a specific type
 */
export function getTagValue(event: NDKEvent, tagType: string): string | undefined {
    const tag = event.tags.find(tag => tag[0] === tagType);
    return tag ? tag[1] : undefined;
}