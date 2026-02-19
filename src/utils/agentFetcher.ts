import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { logger } from "./logger";

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
 * @returns The agent definition or null if not found
 */
export async function fetchAgentDefinition(
    eventId: string,
    ndk: NDK
): Promise<{
    id: string;
    slug: string | undefined;
    title: string;
    description: string;
    markdownDescription: string | undefined;
    role: string;
    instructions: string;
    useCriteria: string;
    version: string;
    created_at: number | undefined;
    pubkey: string;
    fileETags: Array<{ eventId: string; relayUrl?: string }>;
    forkSource: { eventId: string; relayUrl?: string } | undefined;
} | null> {
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
            version: agentDef.version.toString(),
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
