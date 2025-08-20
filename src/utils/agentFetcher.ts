import type NDK from "@nostr-dev-kit/ndk";
import { logger } from "./logger";

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
  title: string;
  description: string;
  role: string;
  instructions: string;
  useCriteria: string;
  version: string;
  created_at: number | undefined;
  pubkey: string;
} | null> {
  try {
    const event = await ndk.fetchEvent(eventId, {
      closeOnEose: true,
      groupable: false,
    });

    if (!event) {
      logger.warning(`Agent event not found: ${eventId}`);
      return null;
    }

    return {
      id: event.id,
      title: event.tagValue("title") || "Unnamed Agent",
      description: event.tagValue("description") || "",
      role: event.tagValue("role") || "assistant",
      instructions: event.content || "",
      useCriteria: event.tagValue("use-criteria") || "",
      version: event.tagValue("ver") || "1.0.0",
      created_at: event.created_at,
      pubkey: event.pubkey,
    };
  } catch (error) {
    logger.error(`Failed to fetch agent event: ${eventId}`, error);
    return null;
  }
}
