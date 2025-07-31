import fs from "node:fs/promises";
import path from "node:path";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { AgentRegistry } from "../agents/AgentRegistry";
import type { Agent } from "../agents/types";
import { getNDK } from "../nostr";
import { getProjectContext, isProjectContextInitialized } from "../services/ProjectContext";
import { fetchAgentDefinition } from "../utils/agentFetcher";
import { logger } from "../utils/logger";
import { toKebabCase } from "../utils/string";

/**
 * Handles project update events by syncing agent definitions.
 * When a project event is received, this function:
 * 1. Checks if the event is for the currently loaded project
 * 2. Identifies new agents that have been added to the project
 * 3. Fetches agent definitions from Nostr for new agents
 * 4. Saves agent definitions to disk and registers them in AgentRegistry
 * 5. Updates the ProjectContext with the new agent configuration
 */
export async function handleProjectEvent(event: NDKEvent, projectPath: string): Promise<void> {
    const title = event.tags.find((tag) => tag[0] === "title")?.[1] || "Untitled";
    logger.info(`📋 Project event update received: ${title}`);

    // Extract agent event IDs from the project
    const agentEventIds = event.tags
        .filter((tag) => tag[0] === "agent" && tag[1])
        .map((tag) => tag[1])
        .filter((id): id is string => typeof id === "string");

    if (agentEventIds.length > 0) {
        logger.info(`Project references ${agentEventIds.length} agent(s)`);
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
        const newAgentEventIds = agentEventIds.filter(
            (id) => !!id && !currentAgentEventIds.has(id)
        );

        // Find agents that need to be removed (exist locally but not in the project)
        const newAgentEventIdsSet = new Set(agentEventIds);
        const agentsToRemove = Array.from(currentAgentEventIds).filter(
            (id) => !newAgentEventIdsSet.has(id)
        );

        if (newAgentEventIds.length === 0 && agentsToRemove.length === 0) {
            logger.debug("No agent changes detected");
            return;
        }

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

        // Reload the agent registry to get all agents including new ones
        await agentRegistry.loadFromProject();

        // Update the project context with new agents
        const updatedAgents = new Map<string, Agent>();
        for (const agent of agentRegistry.getAllAgents()) {
            updatedAgents.set(agent.slug, agent);
        }

        // Create NDKProject from the event
        const ndkProject = event as NDKProject;

        // Update the existing project context atomically
        currentContext.updateProjectData(ndkProject, updatedAgents);

        logger.info("Project context updated with new agents", {
            totalAgents: updatedAgents.size,
            newAgentsAdded: newAgentEventIds.length,
        });
    } catch (error) {
        logger.error("Failed to update agents from project event", { error });
    }
}
