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
import { installAgentFromNostr } from "../agents/agent-installer";
import { logger } from "../utils/logger";
import { trace } from "@opentelemetry/api";

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

    // Extract agent event IDs from the project
    const agentEventIds = TagExtractor.getTagValues(event, "agent")
        .filter((id): id is string => typeof id === "string");

    // Extract MCP tool event IDs from the project
    const mcpEventIds = TagExtractor.getTagValues(event, "mcp")
        .filter((id): id is string => typeof id === "string");

    trace.getActiveSpan()?.addEvent("project.update_received", {
        "project.title": title,
        "project.agent_count": agentEventIds.length,
        "project.mcp_count": mcpEventIds.length,
    });

    // Only process if project context is initialized (daemon is running)
    if (!isProjectContextInitialized()) {
        return;
    }

    try {
        const currentContext = getProjectContext();

        // Check if this is the same project that's currently loaded
        const currentProjectDTag = currentContext.project.dTag;
        const eventDTag = TagExtractor.getDTag(event);

        if (currentProjectDTag !== eventDTag) {
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
                        await agentRegistry.removeAgentFromProject(agent.slug);
                    } catch (error) {
                        logger.error(`Error removing agent ${agent.slug}`, { error });
                    }
                }
            }
        }

        // Process agent and MCP tool changes
        const ndk = getNDK();

        // Fetch and install new agent definitions using shared function
        if (newAgentEventIds.length > 0) {
            for (const eventId of newAgentEventIds) {
                try {
                    await installAgentFromNostr(eventId, undefined, ndk);
                } catch (error) {
                    logger.error("Failed to install agent from event", { eventId, error });
                }
            }
            // Reload the agent registry to pick up new agents
            await currentContext.agentRegistry.loadFromProject(ndkProject);
        }

        // Process MCP tool changes

        // Get currently installed MCP event IDs (only those with event IDs)
        const installedMCPEventIds = await getInstalledMCPEventIds(projectPath);

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
                }
            } catch (error) {
                logger.error("Failed to fetch or install MCP tool", { error, eventId });
            }
        }

        // Reload MCP service if there were any MCP tool changes
        const hasMCPChanges = newMCPEventIds.length > 0 || mcpToolsToRemove.length > 0;
        if (hasMCPChanges) {
            await mcpService.reload(projectPath);
        }

        // Update the existing project context atomically
        // This will reload agents from the project
        await currentContext.updateProjectData(ndkProject);

        trace.getActiveSpan()?.addEvent("project.updated", {
            "project.total_agents": currentContext.agents.size,
            "project.agents_added": newAgentEventIds.length,
            "project.agents_removed": agentsToRemove.length,
            "project.mcp_added": newMCPEventIds.length,
            "project.mcp_removed": mcpToolsToRemove.length,
        });
    } catch (error) {
        logger.error("Failed to update project from event", { error });
    }
}
