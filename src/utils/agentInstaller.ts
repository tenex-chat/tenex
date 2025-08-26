import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import { toKebabCase } from "@/utils/string";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";

/**
 * Result of installing an agent from an event
 */
export interface AgentInstallResult {
  success: boolean;
  agent?: AgentInstance;
  slug?: string;
  message?: string;
  error?: string;
  alreadyExists?: boolean;
}

/**
 * Installs an agent from a Nostr event into a project.
 * This is the shared business logic for adding agents from definition events.
 * 
 * @param eventId - The event ID of the agent definition (can include "nostr:" prefix)
 * @param projectPath - The path to the project
 * @param ndkProject - Optional NDK project for publishing events
 * @param customSlug - Optional custom slug for the agent
 * @param ndk - Optional NDK instance (will use default if not provided)
 * @returns Result of the installation
 */
export async function installAgentFromEvent(
  eventId: string,
  projectPath: string,
  ndkProject?: NDKProject,
  customSlug?: string,
  ndk?: NDK
): Promise<AgentInstallResult> {
  try {
    // Use provided NDK or get default
    const ndkInstance = ndk || getNDK();
    
    // Clean the event ID
    const cleanEventId = eventId.startsWith("nostr:") ? eventId.substring(6) : eventId;
    
    // Fetch the full event to get access to tags
    const agentEvent = await ndkInstance.fetchEvent(cleanEventId, { groupable: false });
    
    if (!agentEvent) {
      return {
        success: false,
        error: `Agent event not found: ${eventId}`,
      };
    }

    // Parse agent definition from the event
    const agentDef = {
      id: agentEvent.id,
      title: agentEvent.tagValue("title") || "Unnamed Agent",
      description: agentEvent.tagValue("description") || "",
      role: agentEvent.tagValue("role") || "assistant",
      instructions: agentEvent.content || "",
      useCriteria: agentEvent.tagValue("use-criteria") || "",
    };

    // Generate slug from name if not provided
    const slug = customSlug || toKebabCase(agentDef.title);

    // Load agent registry
    const registry = new AgentRegistry(projectPath, false);
    await registry.loadFromProject();

    // Check if agent already exists
    const existingAgent = registry.getAgent(slug);
    if (existingAgent) {
      if (existingAgent.eventId === agentDef.id) {
        return {
          success: true,
          alreadyExists: true,
          message: `Agent "${agentDef.title}" is already installed in the project`,
          agent: existingAgent,
          slug,
        };
      }
      return {
        success: false,
        error: `An agent with slug "${slug}" already exists but with a different event ID`,
      };
    }

    // Extract tool requirements from the agent definition event
    const toolTags = agentEvent.tags
      .filter(tag => tag[0] === "tool" && tag[1])
      .map(tag => tag[1]);

    if (toolTags.length > 0) {
      logger.info(`Agent "${agentDef.title}" requests access to ${toolTags.length} tool(s):`, toolTags);
    }

    // Save agent definition file
    const agentsDir = path.join(projectPath, ".tenex", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    
    const filePath = path.join(agentsDir, `${cleanEventId}.json`);
    const agentData = {
      name: agentDef.title,
      role: agentDef.role,
      description: agentDef.description,
      instructions: agentDef.instructions,
      useCriteria: agentDef.useCriteria,
      tools: toolTags, // Include the requested tools
    };
    await fs.writeFile(filePath, JSON.stringify(agentData, null, 2));
    logger.info("Saved agent definition", { eventId: cleanEventId, name: agentDef.title });

    // Create agent configuration
    const agentConfig = {
      name: agentDef.title,
      role: agentDef.role,
      description: agentDef.description,
      instructions: agentDef.instructions,
      useCriteria: agentDef.useCriteria,
      tools: toolTags, // Include the requested tools
      eventId: agentDef.id,
    };

    // Register the agent
    const agent = await registry.ensureAgent(slug, agentConfig, ndkProject);
    logger.info("Registered new agent", { slug, name: agentDef.title });

    return {
      success: true,
      agent,
      slug,
      message: `Successfully installed agent "${agentDef.title}"`,
    };
  } catch (error) {
    logger.error("Failed to install agent from event", { error, eventId });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Installs multiple agents from events in parallel
 * 
 * @param eventIds - Array of event IDs to install
 * @param projectPath - The path to the project
 * @param ndkProject - Optional NDK project for publishing events
 * @param ndk - Optional NDK instance
 * @returns Array of installation results
 */
export async function installAgentsFromEvents(
  eventIds: string[],
  projectPath: string,
  ndkProject?: NDKProject,
  ndk?: NDK
): Promise<AgentInstallResult[]> {
  const results = await Promise.all(
    eventIds.map(eventId => installAgentFromEvent(eventId, projectPath, ndkProject, undefined, ndk))
  );
  
  const successCount = results.filter(r => r.success).length;
  const failureCount = results.filter(r => !r.success).length;
  
  if (successCount > 0) {
    logger.info(`Successfully installed ${successCount} agent(s)`);
  }
  if (failureCount > 0) {
    logger.warn(`Failed to install ${failureCount} agent(s)`);
  }
  
  return results;
}