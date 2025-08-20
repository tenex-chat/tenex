import { AgentRegistry } from "@/agents/AgentRegistry";
import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/ProjectContext";
import type { ExecutionContext, Result, Tool, ToolError, Validated } from "@/tools/types";
import { createZodSchema, failure, success } from "@/tools/types";
import { fetchAgentDefinition } from "@/utils/agentFetcher";
import { logger } from "@/utils/logger";
import { filterAndRelaySetFromBech32 } from "@nostr-dev-kit/ndk";
import { z } from "zod";

// Define the input schema
const agentsHireSchema = z.object({
  eventId: z.string().describe("The event ID of the Agent Definition Event to hire"),
  slug: z
    .string()
    .optional()
    .describe("Optional custom slug for the agent (defaults to normalized name)"),
});

type AgentsHireInput = z.infer<typeof agentsHireSchema>;

// Define the output type
interface AgentsHireOutput {
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
}

/**
 * Tool: agents_hire
 * Hire (add) an NDKAgentDefinition from the Nostr network to the project
 */
export const agentsHire: Tool<AgentsHireInput, AgentsHireOutput> = {
  name: "agents_hire",
  description:
    "Hire (add) a new agent from the Nostr network to the current project using its event ID",
  parameters: createZodSchema(agentsHireSchema),
  execute: async (
    input: Validated<AgentsHireInput>,
    _context: ExecutionContext
  ): Promise<Result<ToolError, AgentsHireOutput>> => {
    try {
      let { eventId, slug } = input.value;

      if (!eventId) {
        return failure({
          kind: "validation",
          field: "eventId",
          message: "Event ID is required to hire an agent",
        });
      }

      // Strip "nostr:" prefix if present
      if (eventId.startsWith("nostr:")) {
        eventId = eventId.substring(6);
      }

      // Get NDK instance for validation and fetching
      const ndk = getNDK();

      // Validate the event ID format
      if (eventId.startsWith("nevent1") || eventId.startsWith("note1")) {
        // Validate bech32 format
        try {
          filterAndRelaySetFromBech32(eventId, ndk);
        } catch (error) {
          return success({
            success: false,
            error: `Invalid event ID format: "${eventId}". Please provide a valid Nostr event ID in bech32 format (e.g., nevent1...) or hex format.`,
          });
        }
      } else if (!/^[0-9a-f]{64}$/i.test(eventId)) {
        // Not a valid hex format either
        return success({
          success: false,
          error: `Invalid event ID format: "${eventId}". Please provide a valid Nostr event ID in bech32 format (e.g., nevent1...) or 64-character hex format.`,
        });
      }

      // Fetch the NDKAgentDefinition from the network
      // fetchAgentDefinition handles both hex and nevent formats
      const agentDefinition = await fetchAgentDefinition(eventId, ndk);

      if (!agentDefinition) {
        return success({
          success: false,
          error: `Agent event not found: ${eventId}. Please ensure you provide a valid agent event ID from the Nostr network (e.g., nevent1qqsfryd2uw56t9jv3x29de0t5dwyzq5...).`,
        });
      }

      // Generate slug from name if not provided
      const agentSlug =
        slug ||
        agentDefinition.title
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");

      // Get project context and registry
      const projectContext = getProjectContext();
      const projectPath = process.cwd();
      const registry = new AgentRegistry(projectPath, false);
      await registry.loadFromProject();

      // Check if agent already exists
      const existingAgent = registry.getAgent(agentSlug);
      if (existingAgent) {
        if (existingAgent.eventId === agentDefinition.id) {
          return success({
            success: true,
            message: `Agent "${agentDefinition.title}" is already installed in the project`,
            agent: {
              slug: agentSlug,
              name: existingAgent.name,
              pubkey: existingAgent.pubkey,
            },
          });
        }
        return success({
          success: false,
          error: `An agent with slug "${agentSlug}" already exists but with a different event ID`,
        });
      }

      // Create agent configuration from NDKAgentDefinition definition
      const agentConfig = {
        name: agentDefinition.title,
        role: agentDefinition.role,
        description: agentDefinition.description,
        instructions: agentDefinition.instructions,
        useCriteria: agentDefinition.useCriteria,
        eventId: agentDefinition.id, // Use the hex ID from the fetched event
      };

      // Add the agent to the project
      const agent = await registry.ensureAgent(agentSlug, agentConfig, projectContext.project);

      // Update the project event to add the new agent reference
      const project = projectContext.project;
      
      // Check if agent is already in project (shouldn't be, but let's be safe)
      const hasAgent = project.tags.some(tag => tag[0] === "agent" && tag[1] === agentDefinition.id);
      
      if (!hasAgent) {
        // Add the agent tag to the project
        project.tags.push(["agent", agentDefinition.id]);
        
        // Sign and publish the updated project event
        await project.sign(projectContext.signer);
        await project.publish();
        
        logger.info(`Updated project event with new agent reference`);
      }

      // Update the ProjectContext with the new agent to trigger 24010 event
      const updatedAgents = new Map(projectContext.agents);
      updatedAgents.set(agentSlug, agent);
      await projectContext.updateProjectData(projectContext.project, updatedAgents);

      logger.info(
        `Successfully hired NDKAgentDefinition "${agentDefinition.title}" (${agentDefinition.id})`
      );
      logger.info(`  Slug: ${agentSlug}`);
      logger.info(`  Pubkey: ${agent.pubkey}`);

      return success({
        success: true,
        message: `Successfully hired agent "${agentDefinition.title}"`,
        agent: {
          slug: agentSlug,
          name: agent.name,
          role: agent.role,
          pubkey: agent.pubkey,
          eventId: agentDefinition.id,
        },
      });
    } catch (error) {
      logger.error("Failed to hire agent", { error });
      return failure({
        kind: "execution",
        tool: "agents_hire",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  },
};
