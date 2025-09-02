import { tool } from 'ai';
import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/ProjectContext";
import type { ExecutionContext } from "@/agents/execution/types";
import { installAgentFromEvent } from "@/utils/agentInstaller";
import { logger } from "@/utils/logger";
import { normalizeNostrIdentifier } from "@/utils/nostr-entity-parser";
import { filterAndRelaySetFromBech32 } from "@nostr-dev-kit/ndk";
import { z } from "zod";
const agentsHireSchema = z.object({
  eventId: z.string().describe("The event ID of the Agent Definition Event to hire"),
  slug: z
    .string()
    .nullable()
    .describe("Optional custom slug for the agent (defaults to normalized name)"),
});

type AgentsHireInput = z.infer<typeof agentsHireSchema>;
type AgentsHireOutput = {
  success: boolean;
  message?: string;
  error?: string;
  agent?: {
    slug: string;
    name: string;
    role?: string;
    pubkey: string;
    eventId?: string;
  };
};

/**
 * Core implementation of the agents_hire functionality
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeAgentsHire(
  input: AgentsHireInput,
  context: ExecutionContext
): Promise<AgentsHireOutput> {
  const { eventId: rawEventId, slug } = input;

  if (!rawEventId) {
    return {
      success: false,
      error: "Event ID is required to hire an agent",
    };
  }

  // Normalize the event ID using our utility
  const eventId = normalizeNostrIdentifier(rawEventId);
  if (!eventId) {
    return {
      success: false,
      error: `Invalid event ID format: "${rawEventId}". Please provide a valid Nostr event ID in bech32 format (e.g., nevent1...) or hex format.`,
    };
  }

  // Get NDK instance for validation and fetching
  const ndk = getNDK();

  // Additional validation for bech32 format
  if (eventId.startsWith("nevent1") || eventId.startsWith("note1")) {
    try {
      filterAndRelaySetFromBech32(eventId, ndk);
    } catch {
      return {
        success: false,
        error: `Invalid event ID format: "${eventId}". Please provide a valid Nostr event ID.`,
      };
    }
  }

  // Get project context
  const projectContext = getProjectContext();
  const projectPath = process.cwd();

  // Use the shared function to install the agent
  const result = await installAgentFromEvent(
    eventId,
    projectPath,
    projectContext.project,
    slug,
    ndk
  );

  if (!result.success) {
    return {
      success: false,
      error: result.error || "Failed to install agent",
    };
  }

  if (result.alreadyExists) {
    return {
      success: true,
      message: result.message,
      agent: result.agent && result.slug ? {
        slug: result.slug,
        name: result.agent.name,
        pubkey: result.agent.pubkey,
      } : undefined,
    };
  }

  const agent = result.agent;
  const agentSlug = result.slug;

  if (!agent || !agentSlug) {
    return {
      success: false,
      error: "Agent installation succeeded but agent or slug is missing",
    };
  }

  // Update the project event to add the new agent reference
  const project = projectContext.project;
  
  // Check if agent is already in project (shouldn't be, but let's be safe)
  const hasAgent = project.tags.some(tag => tag[0] === "agent" && tag[1] === agent.eventId);
  
  if (!hasAgent) {
    // Add the agent tag to the project
    if (agent.eventId) {
      project.tags.push(["agent", agent.eventId]);
    }
    
    // Sign and publish the updated project event
    await project.sign(projectContext.signer);
    await project.publish();
    
    logger.info(`Updated project event with new agent reference`);
  }

  // Update the ProjectContext with the new agent to trigger 24010 event
  const updatedAgents = new Map(projectContext.agents);
  updatedAgents.set(agentSlug, agent);
  await projectContext.updateProjectData(projectContext.project, updatedAgents);

  logger.info(`Successfully hired agent "${agent.name}" (${agent.eventId})`);
  logger.info(`  Slug: ${agentSlug}`);
  logger.info(`  Pubkey: ${agent.pubkey}`);

  return {
    success: true,
    message: result.message,
    agent: {
      slug: agentSlug,
      name: agent.name,
      role: agent.role,
      pubkey: agent.pubkey,
      eventId: agent.eventId,
    },
  };
}

/**
 * Create an AI SDK tool for hiring agents
 * This is the primary implementation
 */
export function createAgentsHireTool(context: ExecutionContext) {
  return tool({
    description: "Hire (add) a new agent from the Nostr network to the current project using its event ID",
    inputSchema: agentsHireSchema,
    execute: async (input: AgentsHireInput) => {
      try {
        return await executeAgentsHire(input, context);
      } catch (error) {
        logger.error("Failed to hire agent", { error });
        throw new Error(`Failed to hire agent: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

