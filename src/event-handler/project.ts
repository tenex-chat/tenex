import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { getTagValue, getDTag } from "../nostr/TagExtractor";
import { getProjectContext } from "@/services/projects";
import { logger } from "../utils/logger";
import { trace } from "@opentelemetry/api";

/**
 * Handles project update events by syncing authoritative agent membership.
 * When a project event is received, this function:
 * 1. Checks if the event is for the currently loaded project
 * 2. Mirrors lowercase `p` agent membership into storage/registry
 * 3. Updates the ProjectContext with the new configuration
 */
export async function handleProjectEvent(event: NDKEvent): Promise<void> {
    const title = getTagValue(event, "title") || "Untitled";

    const agentPubkeys = event.tags
        .filter((tag) => tag[0] === "p" && tag[1])
        .map((tag) => tag[1])
        .filter((pubkey): pubkey is string => typeof pubkey === "string");

    trace.getActiveSpan()?.addEvent("project.update_received", {
        "project.title": title,
        "project.agent_count": agentPubkeys.length,
    });

    try {
        const currentContext = getProjectContext();

        const currentProjectDTag = currentContext.project.dTag;
        const eventDTag = getDTag(event);

        if (currentProjectDTag !== eventDTag) {
            return;
        }

        const ndkProject = event as NDKProject;

        await currentContext.updateProjectData(ndkProject);

        trace.getActiveSpan()?.addEvent("project.updated", {
            "project.total_agents": currentContext.agents.size,
        });
    } catch (error) {
        logger.error("Failed to update project from event", { error });
    }
}
