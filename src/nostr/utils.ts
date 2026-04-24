import type { ProjectContext } from "@/services/projects/ProjectContext";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

type EventAgentLookupContext = Pick<ProjectContext, "projectManager" | "agents">;

/**
 * Check if an event is from an agent (either project agent or individual agent)
 * @param event - The NDK event to check
 * @param projectContext - Explicit project-scoped agent lookup context
 * @returns true if the event is from an agent, false if from a user
 */
export function isEventFromAgent(
    event: NDKEvent,
    projectContext: EventAgentLookupContext
): boolean {
    // Check if it's from the project manager
    if (projectContext.projectManager?.pubkey === event.pubkey) {
        return true;
    }

    // Check if it's from any of the registered agents
    for (const agent of projectContext.agents.values()) {
        if (agent.pubkey === event.pubkey) {
            return true;
        }
    }

    return false;
}

/**
 * Check if an event is from a user (not from an agent)
 * @param event - The NDK event to check
 * @param projectContext - Explicit project-scoped agent lookup context
 * @returns true if the event is from a user, false if from an agent
 */
export function isEventFromUser(
    event: NDKEvent,
    projectContext: EventAgentLookupContext
): boolean {
    return !isEventFromAgent(event, projectContext);
}

/**
 * Get the agent slug if the event is from an agent
 * @param event - The NDK event to check
 * @param projectContext - Explicit project-scoped agent lookup context
 * @returns The agent slug if found, undefined otherwise
 */
export function getAgentSlugFromEvent(
    event: NDKEvent,
    projectContext: Pick<ProjectContext, "agents">
): string | undefined {
    if (!event.pubkey) return undefined;

    for (const [slug, agent] of projectContext.agents) {
        if (agent.pubkey === event.pubkey) {
            return slug;
        }
    }

    return undefined;
}
