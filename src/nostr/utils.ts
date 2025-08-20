import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { getProjectContext, isProjectContextInitialized } from "@/services";

/**
 * Check if an event is from an agent (either project agent or individual agent)
 * @param event - The NDK event to check
 * @returns true if the event is from an agent, false if from a user
 */
export function isEventFromAgent(event: NDKEvent): boolean {
  const projectCtx = getProjectContext();

  // Check if it's from the project itself
  if (projectCtx.pubkey === event.pubkey) {
    return true;
  }

  // Check if it's from any of the registered agents
  for (const agent of projectCtx.agents.values()) {
    if (agent.pubkey === event.pubkey) {
      return true;
    }
  }

  return false;
}

/**
 * Check if an event is from a user (not from an agent)
 * @param event - The NDK event to check
 * @returns true if the event is from a user, false if from an agent
 */
export function isEventFromUser(event: NDKEvent): boolean {
  return !isEventFromAgent(event);
}

/**
 * Get the agent slug if the event is from an agent
 * @param event - The NDK event to check
 * @returns The agent slug if found, undefined otherwise
 */
export function getAgentSlugFromEvent(event: NDKEvent): string | undefined {
  if (!event.pubkey) return undefined;

  if (!isProjectContextInitialized()) {
    // Project context not initialized
    return undefined;
  }

  const projectCtx = getProjectContext();
  for (const [slug, agent] of projectCtx.agents) {
    if (agent.pubkey === event.pubkey) {
      return slug;
    }
  }

  return undefined;
}
