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
 * @param agentRegistry - Optional AgentRegistry to use (will create new if not provided)
 * @returns Result of the installation
 */
export async function installAgentFromEvent(
  eventId: string,
  projectPath: string,
  ndkProject?: NDKProject,
  customSlug?: string,
  ndk?: NDK,
  agentRegistry?: AgentRegistry
): Promise<AgentInstallResult> {
  try {
    // Use provided NDK or get default
    const ndkInstance = ndk || getNDK();
    
    // Clean the event ID
    const cleanEventId = eventId.startsWith("nostr:") ? eventId.substring(6) : eventId;
    
    // Fetch the full event to get access to tags
    logger.debug(`Fetching agent event ${cleanEventId} from Nostr relays`);
    const agentEvent = await ndkInstance.fetchEvent(cleanEventId, { groupable: false });

    if (!agentEvent) {
      // Check if we have a local copy already
      const agentsDir = path.join(projectPath, ".tenex", "agents");
      const localFilePath = path.join(agentsDir, `${cleanEventId}.json`);

      try {
        await fs.access(localFilePath);
        logger.warn(`Agent event ${cleanEventId} not found on Nostr relays, but local copy exists`);
        // We have a local copy, but can't verify/update it without the event
        // This is a warning condition - the agent might be out of date
        return {
          success: false,
          error: `Agent event ${cleanEventId} not found on Nostr relays. Local copy exists but cannot be verified. Check your relay configuration.`,
        };
      } catch {
        // No local copy either
        return {
          success: false,
          error: `Agent event ${cleanEventId} not found on Nostr relays and no local copy exists. The event may not have been published yet or your relays may not have it.`,
        };
      }
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

    // Use provided registry or create new one
    const registry = agentRegistry || new AgentRegistry(projectPath, false);
    if (!agentRegistry) {
      await registry.loadFromProject();
    }

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

    // Extract phase definitions from the agent definition event
    const phaseTags = agentEvent.tags.filter(tag => tag[0] === "phase" && tag[1] && tag[2]);
    let phases: Record<string, string> | undefined;
    if (phaseTags.length > 0) {
      phases = {};
      for (const [, phaseName, instructions] of phaseTags) {
        phases[phaseName] = instructions;
      }
      logger.info(`Agent "${agentDef.title}" defines ${Object.keys(phases).length} phase(s):`, Object.keys(phases));
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
      ...(phases && { phases }), // Include phases if defined
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
      ...(phases && { phases }), // Include phases if defined
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
 * Load agent from local file when Nostr event is not available
 * This is a fallback for when the network is down or the event isn't on relays
 */
export async function loadAgentFromLocalFile(
  eventId: string,
  projectPath: string,
  agentRegistry: AgentRegistry
): Promise<AgentInstallResult> {
  try {
    const cleanEventId = eventId.startsWith("nostr:") ? eventId.substring(6) : eventId;
    const agentsDir = path.join(projectPath, ".tenex", "agents");
    const localFilePath = path.join(agentsDir, `${cleanEventId}.json`);

    // Check if local file exists
    const fileContent = await fs.readFile(localFilePath, 'utf-8');
    const agentData = JSON.parse(fileContent);

    // Generate slug from name
    const slug = toKebabCase(agentData.name);

    // Check if agent already exists in registry
    const existingAgent = agentRegistry.getAgent(slug);
    if (existingAgent && existingAgent.eventId === cleanEventId) {
      return {
        success: true,
        alreadyExists: true,
        message: `Agent "${agentData.name}" already loaded from local file`,
        agent: existingAgent,
        slug,
      };
    }

    // Create agent configuration from local data
    const agentConfig = {
      name: agentData.name,
      role: agentData.role,
      description: agentData.description,
      instructions: agentData.instructions,
      useCriteria: agentData.useCriteria,
      tools: agentData.tools || [],
      eventId: cleanEventId,
      ...(agentData.phases && { phases: agentData.phases }),
    };

    // Register the agent
    const agent = await agentRegistry.ensureAgent(slug, agentConfig);
    logger.info("Loaded agent from local file", { slug, name: agentData.name, eventId: cleanEventId });

    return {
      success: true,
      agent,
      slug,
      message: `Successfully loaded agent "${agentData.name}" from local file (Nostr sync unavailable)`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to load agent from local file: ${error instanceof Error ? error.message : String(error)}`,
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
 * @param agentRegistry - Optional AgentRegistry to use
 * @returns Array of installation results
 */
export async function installAgentsFromEvents(
  eventIds: string[],
  projectPath: string,
  ndkProject?: NDKProject,
  ndk?: NDK,
  agentRegistry?: AgentRegistry
): Promise<AgentInstallResult[]> {
  const results = await Promise.all(
    eventIds.map(eventId => installAgentFromEvent(eventId, projectPath, ndkProject, undefined, ndk, agentRegistry))
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