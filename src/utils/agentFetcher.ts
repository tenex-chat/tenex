import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { logger } from "./logger";

/**
 * Represents the parsed data from an agent definition event.
 * Contains all fields needed to instantiate or display an agent.
 */
export interface AgentDefinitionData {
    /** The Nostr event ID of the agent definition */
    id: string;
    /** The slug identifier (d-tag) for versioning */
    slug: string | undefined;
    /** Display name of the agent */
    title: string;
    /** Short one-liner description */
    description: string;
    /** Extended markdown description from content field */
    markdownDescription: string | undefined;
    /** The agent's role/personality */
    role: string;
    /** Detailed operational instructions */
    instructions: string;
    /** Criteria for when to use this agent */
    useCriteria: string;
    /** Version number of the agent definition */
    version: number;
    /** Unix timestamp when the event was created */
    created_at: number | undefined;
    /** Pubkey of the agent definition author */
    pubkey: string;
    /** References to bundled file metadata events */
    fileETags: Array<{ eventId: string; relayUrl?: string }>;
    /** Reference to the source agent if this is a fork */
    forkSource: { eventId: string; relayUrl?: string } | undefined;
}

/**
 * Fetches an agent event from Nostr
 * @param eventId - The ID of the event containing the agent
 * @param ndk - The NDK instance to use for fetching
 * @returns The agent event or null if not found
 */
export async function fetchAgent(eventId: string, ndk: NDK): Promise<NDKEvent | null> {
    try {
        // Strip "nostr:" prefix if present
        const cleanEventId = eventId.startsWith("nostr:") ? eventId.substring(6) : eventId;

        const event = await ndk.fetchEvent(cleanEventId, { groupable: false });

        if (!event) {
            logger.debug(`Agent event not found: ${cleanEventId}`);
            return null;
        }

        return event;
    } catch (error) {
        logger.error(`Failed to fetch agent event: ${eventId}`, error);
        return null;
    }
}

/**
 * Fetches an agent definition from a Nostr event
 * @param eventId - The ID of the event containing the agent definition
 * @param ndk - The NDK instance to use for fetching
 * @returns The agent definition data or null if not found
 */
export async function fetchAgentDefinition(
    eventId: string,
    ndk: NDK
): Promise<AgentDefinitionData | null> {
    try {
        // Strip "nostr:" prefix if present
        const cleanEventId = eventId.startsWith("nostr:") ? eventId.substring(6) : eventId;

        const event = await ndk.fetchEvent(cleanEventId, { groupable: false });

        if (!event) {
            logger.warning(`Agent event not found: ${cleanEventId}`);
            return null;
        }

        // Use NDKAgentDefinition for proper parsing
        const agentDef = NDKAgentDefinition.from(event);

        return {
            id: event.id,
            slug: agentDef.slug,
            title: agentDef.title || "Unnamed Agent",
            description: agentDef.description || "",
            markdownDescription: agentDef.markdownDescription,
            role: agentDef.role || "assistant",
            instructions: agentDef.instructions || "",
            useCriteria: agentDef.useCriteria || "",
            version: agentDef.version,
            created_at: event.created_at,
            pubkey: event.pubkey,
            fileETags: agentDef.getFileETags(),
            forkSource: agentDef.getForkSource(),
        };
    } catch (error) {
        logger.error(`Failed to fetch agent event: ${eventId}`, error);
        return null;
    }
}
