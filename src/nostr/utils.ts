import { getProjectContext, isProjectContextInitialized } from "@/services";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

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

/**
 * Get the agent slugs that are targeted by this event based on p-tags
 * @param event - The NDK event to check
 * @returns Array of agent slugs that are targeted by this event
 */
export function getTargetedAgentSlugsFromEvent(event: NDKEvent): string[] {
  if (!isProjectContextInitialized()) {
    return [];
  }

  const projectCtx = getProjectContext();
  const targetedSlugs: string[] = [];
  
  // Get all p-tags from the event
  const pTags = event.getMatchingTags("p");
  if (pTags.length === 0) {
    return [];
  }
  
  // Check each p-tag to see if it matches an agent
  for (const pTag of pTags) {
    const pubkey = pTag[1];
    if (!pubkey) continue;
    
    // Check if this pubkey belongs to an agent
    for (const [slug, agent] of projectCtx.agents) {
      if (agent.pubkey === pubkey) {
        targetedSlugs.push(slug);
        break;
      }
    }
  }
  
  return targetedSlugs;
}

/**
 * Check if an event targets a specific agent
 * @param event - The NDK event to check
 * @param agentSlug - The slug of the agent to check
 * @returns true if the event targets this specific agent
 */
export function isEventTargetedToAgent(event: NDKEvent, agentSlug: string): boolean {
  const targetedSlugs = getTargetedAgentSlugsFromEvent(event);
  return targetedSlugs.includes(agentSlug);
}
