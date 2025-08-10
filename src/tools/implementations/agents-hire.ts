import type { Tool, ExecutionContext, Result, ToolError, Validated } from "@/tools/types";
import { createZodSchema, success, failure } from "@/tools/types";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { fetchAgentDefinition } from "@/utils/agentFetcher";
import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { z } from "zod";

// Define the input schema
const agentsHireSchema = z.object({
    eventId: z.string().describe("The event ID of the Agent Definition Event to hire"),
    slug: z.string().optional().describe("Optional custom slug for the agent (defaults to normalized name)"),
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
    description: "Hire (add) a new agent from the Nostr network to the current project using its event ID",
    parameters: createZodSchema(agentsHireSchema),
    execute: async (
        input: Validated<AgentsHireInput>,
        context: ExecutionContext
    ): Promise<Result<ToolError, AgentsHireOutput>> => {
        try {
            const { eventId, slug } = input.value;

            if (!eventId) {
                return failure({
                    kind: "validation",
                    field: "eventId",
                    message: "Event ID is required to hire an agent",
                });
            }

            // Fetch the NDKAgentDefinition from the network
            const ndk = getNDK();
            const agentDefinition = await fetchAgentDefinition(eventId, ndk);

            if (!agentDefinition) {
                return success({
                    success: false,
                    error: `NDKAgentDefinition with event ID ${eventId} not found on the network`,
                });
            }

            // Generate slug from name if not provided
            const agentSlug = slug || agentDefinition.title
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9-]/g, '');

            // Get project context and registry
            const projectContext = getProjectContext();
            const projectPath = process.cwd();
            const registry = new AgentRegistry(projectPath, false);
            await registry.loadFromProject();

            // Check if agent already exists
            const existingAgent = registry.getAgent(agentSlug);
            if (existingAgent) {
                if (existingAgent.eventId === eventId) {
                    return success({
                        success: true,
                        message: `Agent "${agentDefinition.title}" is already installed in the project`,
                        agent: {
                            slug: agentSlug,
                            name: existingAgent.name,
                            pubkey: existingAgent.pubkey,
                        },
                    });
                } else {
                    return success({
                        success: false,
                        error: `An agent with slug "${agentSlug}" already exists but with a different event ID`,
                    });
                }
            }

            // Create agent configuration from NDKAgentDefinition definition
            const agentConfig = {
                name: agentDefinition.title,
                role: agentDefinition.role,
                description: agentDefinition.description,
                instructions: agentDefinition.instructions,
                useCriteria: agentDefinition.useCriteria,
                eventId: eventId, // Link to the original NDKAgentDefinition event
            };

            // Add the agent to the project
            const agent = await registry.ensureAgent(agentSlug, agentConfig, projectContext.project);

            logger.info(`Successfully hired NDKAgentDefinition "${agentDefinition.title}" (${eventId})`);
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
                    eventId: eventId,
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