import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { NDKMCPTool } from "../events/NDKMCPTool";
import { getNDK } from "../nostr";
import { getTagValue, getTagValues, getDTag } from "../nostr/TagExtractor";
import { getProjectContext } from "@/services/projects";
import {
    getInstalledMCPEventIds,
    installMCPServerFromEvent,
    removeMCPServerByEventId,
} from "../services/mcp/mcpInstaller";
import { logger } from "../utils/logger";
import { trace } from "@opentelemetry/api";

/**
 * Handles project update events by syncing authoritative membership and MCP tools.
 * When a project event is received, this function:
 * 1. Checks if the event is for the currently loaded project
 * 2. Mirrors lowercase `p` agent membership into storage/registry
 * 3. Fetches definitions for new MCP tools
 * 4. Saves definitions to disk and registers them
 * 5. Updates the ProjectContext with the new configuration
 */
export async function handleProjectEvent(event: NDKEvent): Promise<void> {
    const title = getTagValue(event, "title") || "Untitled";

    const agentPubkeys = event.tags
        .filter((tag) => tag[0] === "p" && tag[1])
        .map((tag) => tag[1])
        .filter((pubkey): pubkey is string => typeof pubkey === "string");

    // Extract MCP tool event IDs from the project
    const mcpEventIds = getTagValues(event, "mcp")
        .filter((id): id is string => typeof id === "string");

    trace.getActiveSpan()?.addEvent("project.update_received", {
        "project.title": title,
        "project.agent_count": agentPubkeys.length,
        "project.mcp_count": mcpEventIds.length,
    });

    try {
        const currentContext = getProjectContext();
        const metadataPath = currentContext.agentRegistry.getMetadataPath();

        // Check if this is the same project that's currently loaded
        const currentProjectDTag = currentContext.project.dTag;
        const eventDTag = getDTag(event);

        if (currentProjectDTag !== eventDTag) {
            return;
        }

        const ndkProject = event as NDKProject;

        // Process agent and MCP tool changes
        const ndk = getNDK();

        // Process MCP tool changes

        // Get currently installed MCP event IDs (only those with event IDs)
        const installedMCPEventIds = await getInstalledMCPEventIds(metadataPath);

        // Find new MCP tools that need to be fetched
        const newMCPEventIds = mcpEventIds.filter((id) => !!id && !installedMCPEventIds.has(id));

        // Find MCP tools that need to be removed (exist locally but not in the project)
        const newMCPEventIdsSet = new Set(mcpEventIds);
        const mcpToolsToRemove = Array.from(installedMCPEventIds).filter(
            (id) => !newMCPEventIdsSet.has(id)
        );

        // Handle MCP tool removals first
        for (const eventId of mcpToolsToRemove) {
            try {
                await removeMCPServerByEventId(metadataPath, eventId);
            } catch (error) {
                logger.error("Failed to remove MCP tool", { error, eventId });
            }
        }

        // Fetch and install new MCP tools
        for (const eventId of newMCPEventIds) {
            try {
                const mcpEvent = await ndk.fetchEvent(eventId);
                if (mcpEvent) {
                    const mcpTool = NDKMCPTool.from(mcpEvent);
                    await installMCPServerFromEvent(metadataPath, mcpTool);
                }
            } catch (error) {
                logger.error("Failed to fetch or install MCP tool", { error, eventId });
            }
        }

        // Reload MCP service if there were any MCP tool changes
        const hasMCPChanges = newMCPEventIds.length > 0 || mcpToolsToRemove.length > 0;
        if (hasMCPChanges && currentContext.mcpManager) {
            await currentContext.mcpManager.reload(metadataPath);
        }

        // Update the existing project context atomically
        // This will reload agents from the project
        await currentContext.updateProjectData(ndkProject);

        trace.getActiveSpan()?.addEvent("project.updated", {
            "project.total_agents": currentContext.agents.size,
            "project.mcp_added": newMCPEventIds.length,
            "project.mcp_removed": mcpToolsToRemove.length,
        });
    } catch (error) {
        logger.error("Failed to update project from event", { error });
    }
}
