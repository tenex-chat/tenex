import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Represents an event with additional context metadata for message building
 */
export interface EventWithContext {
    event: NDKEvent;
    timestamp: number;
    isDelegationRequest?: boolean;
    isDelegationResponse?: boolean;
    delegationId?: string;
    delegationContent?: string;
    delegatedToPubkey?: string;
    delegatedToName?: string;
}

/**
 * Represents a previous subthread this agent participated in
 */
export interface PreviousSubthread {
    delegationEventId: string;
    delegatorSlug: string;
    delegatorPubkey: string;
    prompt: string;
    response?: string;
    timestamp: number;
}

/**
 * Data structure for delegation tracking and rendering
 */
export interface DelegationData {
    id: string;
    from: string;
    recipients: string[];
    phase?: string;
    message: string;
    requestEventId: string;
    requestEvent: NDKEvent;
    responses: Array<{
        from: string;
        content: string;
        eventId: string;
        status: "completed" | "error";
    }>;
}
