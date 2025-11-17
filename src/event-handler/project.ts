import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { NDKMCPTool } from "../events/NDKMCPTool";
import { getNDK } from "../nostr";
import { TagExtractor } from "../nostr/TagExtractor";
import { getProjectContext, isProjectContextInitialized } from "../services/ProjectContext";
import { mcpService } from "../services/mcp/MCPManager";
import {
    getInstalledMCPEventIds,
    installMCPServerFromEvent,
    removeMCPServerByEventId,
} from "../services/mcp/mcpInstaller";
import { installAgentsFromEvents } from "../utils/agentInstaller";
import { logger } from "../utils/logger";

/**
 * Handles project update events by syncing agent and MCP tool definitions.
 * When a project event is received, this function:
 * 1. Checks if the event is for the currently loaded project
 * 2. Identifies new agents and MCP tools that have been added to the project
 * 3. Fetches definitions from Nostr for new agents and MCP tools
 * 4. Saves definitions to disk and registers them
 * 5. Updates the ProjectContext with the new configuration
 */
export async function handleProjectEvent(event: NDKEvent, projectPath: string): Promise<void> {
    const title = TagExtractor.getTagValue(event, "title") || "Untitled";
    logger.info(`📋 Project event update received: ${title}`);

    // Extract agent event IDs from the project
    const agentEventIds = TagExtractor.getTagValues(event, "agent")
        .filter((id): id is string => typeof id === "string");

    // Extract MCP tool event IDs from the project
    const mcpEventIds = TagExtractor.getTagValues(event, "mcp")
        .filter((id): id is string => typeof id === "string");

    if (agentEventIds.length > 0) {
        logger.info(`Project references ${agentEventIds.length} agent(s)`);
    }
    if (mcpEventIds.length > 0) {
        logger.info(`Project references ${mcpEventIds.length} MCP tool(s)`);
    }

    // Only process if project context is initialized (daemon is running)
    if (!isProjectContextInitialized()) {
        logger.debug("Project context not initialized, skipping agent update");
        return;
    }

    try {
        const currentContext = getProjectContext();

        // Check if this is the same project that's currently loaded
        const currentProjectDTag = currentContext.project.dTag;
        const eventDTag = TagExtractor.getDTag(event);

        if (currentProjectDTag !== eventDTag) {
            logger.debug("Project event is for a different project, skipping", {
                currentProjectDTag,
                eventDTag,
            });
            return;
        }

        const ndkProject = event as NDKProject;

        // Track which agents need to be added or updated
        const currentAgentEventIds = new Set<string>();
        for (const agent of currentContext.agents.values()) {
            if (agent.eventId) {
                currentAgentEventIds.add(agent.eventId);
            }
        }

        // Find new agents that need to be fetched
        const newAgentEventIds = agentEventIds.filter(
            (id) => !!id && !currentAgentEventIds.has(id)
        );

        // Find agents that need to be removed (exist locally but not in the project)
        const newAgentEventIdsSet = new Set(agentEventIds);
        const agentsToRemove = Array.from(currentAgentEventIds).filter(
            (id) => !newAgentEventIdsSet.has(id)
        );

        // We'll process if there are any changes to agents OR MCP tools

        if (newAgentEventIds.length > 0) {
            logger.info(`Found ${newAgentEventIds.length} new agent(s) to add`);
        }

        if (agentsToRemove.length > 0) {
            logger.info(`Found ${agentsToRemove.length} agent(s) to remove`);
        }

        // Handle agent removals first
        if (agentsToRemove.length > 0) {
            const agentRegistry = currentContext.agentRegistry;

            for (const eventId of agentsToRemove) {
                // Find agent by eventId
                const agent = Array.from(currentContext.agents.values()).find(
                    (a) => a.eventId === eventId
                );

                if (agent) {
                    try {
                        const removed = await agentRegistry.removeAgentFromProject(agent.slug);
                        if (removed) {
                            logger.info(`Removed agent ${agent.slug} from project`);
                        } else {
                            logger.warn(`Failed to remove agent ${agent.slug} from project`);
                        }
                    } catch (error) {
                        logger.error(`Error removing agent ${agent.slug}`, { error });
                    }
                }
            }
        }

        // Fetch and install new agent definitions using shared function
        if (newAgentEventIds.length > 0) {
            await installAgentsFromEvents(
                newAgentEventIds,
                projectPath,
                ndkProject,
                getNDK(),
                currentContext.agentRegistry
            );
        }

        // Process MCP tool changes
        const ndk = getNDK();

        // Get currently installed MCP event IDs (only those with event IDs)
        const installedMCPEventIds = await getInstalledMCPEventIds(projectPath);

        // Find new MCP tools that need to be fetched
        const newMCPEventIds = mcpEventIds.filter((id) => !!id && !installedMCPEventIds.has(id));

        // Find MCP tools that need to be removed (exist locally but not in the project)
        const newMCPEventIdsSet = new Set(mcpEventIds);
        const mcpToolsToRemove = Array.from(installedMCPEventIds).filter(
            (id) => !newMCPEventIdsSet.has(id)
        );

        if (newMCPEventIds.length > 0) {
            logger.info(`Found ${newMCPEventIds.length} new MCP tool(s) to add`);
        }

        if (mcpToolsToRemove.length > 0) {
            logger.info(`Found ${mcpToolsToRemove.length} MCP tool(s) to remove`);
        }

        // Handle MCP tool removals first
        for (const eventId of mcpToolsToRemove) {
            try {
                await removeMCPServerByEventId(projectPath, eventId);
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
                    await installMCPServerFromEvent(projectPath, mcpTool);
                    logger.info("Installed MCP tool from project update", {
                        eventId,
                        name: mcpTool.name,
                    });
                }
            } catch (error) {
                logger.error("Failed to fetch or install MCP tool", { error, eventId });
            }
        }

        // Reload MCP service if there were any MCP tool changes
        const hasMCPChanges = newMCPEventIds.length > 0 || mcpToolsToRemove.length > 0;
        if (hasMCPChanges) {
            logger.info("Reloading MCP service after tool changes");
            await mcpService.reload(projectPath);
        }

        // Update the existing project context atomically
        // This will reload agents from the project
        await currentContext.updateProjectData(ndkProject);

        logger.info("Project context updated", {
            totalAgents: currentContext.agents.size,
            newAgentsAdded: newAgentEventIds.length,
            agentsRemoved: agentsToRemove.length,
            newMCPToolsAdded: newMCPEventIds.length,
            mcpToolsRemoved: mcpToolsToRemove.length,
            mcpReloaded: hasMCPChanges,
        });
    } catch (error) {
        logger.error("Failed to update project from event", { error });
    }
}
