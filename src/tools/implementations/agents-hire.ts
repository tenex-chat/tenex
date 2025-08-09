import type { Tool, ToolFunction } from "@/tools/types";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { fetchAgentDefinition } from "@/utils/agentFetcher";
import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { z } from "zod";

/**
 * Tool function to hire (add) an NDKAgent to the project
 */
const agentsHireTool: ToolFunction = async (args) => {
    try {
        const { eventId, slug } = args as {
            eventId: string;
            slug?: string;
        };

        if (!eventId) {
            throw new Error("Event ID is required to hire an agent");
        }

        // Fetch the NDKAgent definition from the network
        const ndk = getNDK();
        const agentDefinition = await fetchAgentDefinition(eventId, ndk);

        if (!agentDefinition) {
            return {
                success: false,
                error: `NDKAgent with event ID ${eventId} not found on the network`,
            };
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
                return {
                    success: true,
                    message: `Agent "${agentDefinition.title}" is already installed in the project`,
                    agent: {
                        slug: agentSlug,
                        name: existingAgent.name,
                        pubkey: existingAgent.pubkey,
                    },
                };
            } else {
                return {
                    success: false,
                    error: `An agent with slug "${agentSlug}" already exists but with a different event ID`,
                };
            }
        }

        // Create agent configuration from NDKAgent definition
        const agentConfig = {
            name: agentDefinition.title,
            role: agentDefinition.role,
            description: agentDefinition.description,
            instructions: agentDefinition.instructions,
            useCriteria: agentDefinition.useCriteria,
            eventId: eventId, // Link to the original NDKAgent event
        };

        // Add the agent to the project
        const agent = await registry.ensureAgent(agentSlug, agentConfig, projectContext.project);

        logger.info(`Successfully hired NDKAgent "${agentDefinition.title}" (${eventId})`);
        logger.info(`  Slug: ${agentSlug}`);
        logger.info(`  Pubkey: ${agent.pubkey}`);

        return {
            success: true,
            message: `Successfully hired agent "${agentDefinition.title}"`,
            agent: {
                slug: agentSlug,
                name: agent.name,
                role: agent.role,
                pubkey: agent.pubkey,
                eventId: eventId,
            },
        };
    } catch (error) {
        logger.error("Failed to hire agent", { error });
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
};

/**
 * Tool: agents_hire
 * Hire (add) an NDKAgent from the Nostr network to the project
 */
export const agentsHire: Tool = {
    name: "agents_hire",
    description: "Hire (add) an NDKAgent from the Nostr network to the current project using its event ID",
    parameters: z.object({
        eventId: z.string().describe("The event ID of the NDKAgent to hire"),
        slug: z.string().optional().describe("Optional custom slug for the agent (defaults to normalized name)"),
    }),
    handler: agentsHireTool,
};