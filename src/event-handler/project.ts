import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { AgentRegistry } from "../agents/AgentRegistry";
import type { AgentInstance } from "../agents/types";
import { NDKMCPTool } from "../events/NDKMCPTool";
import { getNDK } from "../nostr";
import { mcpService } from "../services/mcp/MCPService";
import {
  getInstalledMCPEventIds,
  installMCPServerFromEvent,
  removeMCPServerByEventId,
} from "../services/mcp/mcpInstaller";
import { getProjectContext, isProjectContextInitialized } from "../services/ProjectContext";
import { fetchAgentDefinition } from "../utils/agentFetcher";
import { logger } from "../utils/logger";
import { toKebabCase } from "../utils/string";

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
  const title = event.tags.find((tag) => tag[0] === "title")?.[1] || "Untitled";
  logger.info(`📋 Project event update received: ${title}`);

  // Extract agent event IDs from the project
  const agentEventIds = event.tags
    .filter((tag) => tag[0] === "agent" && tag[1])
    .map((tag) => tag[1])
    .filter((id): id is string => typeof id === "string");

  // Extract MCP tool event IDs from the project
  const mcpEventIds = event.tags
    .filter((tag) => tag[0] === "mcp" && tag[1])
    .map((tag) => tag[1])
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
    const eventDTag = event.tags.find((tag) => tag[0] === "d")?.[1];

    if (currentProjectDTag !== eventDTag) {
      logger.debug("Project event is for a different project, skipping", {
        currentProjectDTag,
        eventDTag,
      });
      return;
    }

    // Load agent registry
    const agentRegistry = new AgentRegistry(projectPath, false);
    await agentRegistry.loadFromProject();

    // Track which agents need to be added or updated
    const currentAgentEventIds = new Set<string>();
    for (const agent of currentContext.agents.values()) {
      if (agent.eventId) {
        currentAgentEventIds.add(agent.eventId);
      }
    }

    // Find new agents that need to be fetched
    const newAgentEventIds = agentEventIds.filter((id) => !!id && !currentAgentEventIds.has(id));

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
    for (const eventId of agentsToRemove) {
      try {
        await agentRegistry.removeAgentByEventId(eventId);
      } catch (error) {
        logger.error("Failed to remove agent", { error, eventId });
      }
    }

    // Fetch and save new agent definitions
    const agentsDir = path.join(projectPath, ".tenex", "agents");
    await fs.mkdir(agentsDir, { recursive: true });

    for (const eventId of newAgentEventIds) {
      try {
        const agentDef = await fetchAgentDefinition(eventId, getNDK());
        if (agentDef) {
          // Save agent definition file
          const filePath = path.join(agentsDir, `${eventId}.json`);
          const agentData = {
            name: agentDef.title,
            role: agentDef.role,
            description: agentDef.description,
            instructions: agentDef.instructions,
            useCriteria: agentDef.useCriteria,
            tools: [],
          };
          await fs.writeFile(filePath, JSON.stringify(agentData, null, 2));
          logger.info("Saved agent definition", { eventId, name: agentDef.title });

          // Generate a slug for the agent
          const slug = toKebabCase(agentDef.title);

          // Ensure the agent is registered
          await agentRegistry.ensureAgent(slug, {
            name: agentDef.title,
            role: agentDef.role,
            description: agentDef.description,
            instructions: agentDef.instructions,
            useCriteria: agentDef.useCriteria,
            tools: [],
            eventId,
          });

          logger.info("Registered new agent", { slug, name: agentDef.title });
        }
      } catch (error) {
        logger.error("Failed to fetch or register agent", { error, eventId });
      }
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

    // Reload the agent registry to get all agents including new ones
    await agentRegistry.loadFromProject();

    // Update the project context with new agents
    const updatedAgents = new Map<string, AgentInstance>();
    for (const agent of agentRegistry.getAllAgents()) {
      updatedAgents.set(agent.slug, agent);
    }

    // Create NDKProject from the event
    const ndkProject = event as NDKProject;

    // Update the existing project context atomically
    currentContext.updateProjectData(ndkProject, updatedAgents);

    logger.info("Project context updated", {
      totalAgents: updatedAgents.size,
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
