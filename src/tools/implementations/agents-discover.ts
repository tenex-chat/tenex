import type { Tool, ExecutionContext, Result, ToolError, Validated } from "@/tools/types";
import { createZodSchema, success, failure } from "@/tools/types";
import { NDKAgentDiscovery } from "@/services/NDKAgentDiscovery";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import { z } from "zod";

// Define the input schema
const agentsDiscoverSchema = z.object({
    searchText: z.string().optional().describe("Text to search for in agent name/description/role"),
    criteriaKeywords: z.array(z.string()).optional().describe("Keywords to match in use criteria"),
});

type AgentsDiscoverInput = z.infer<typeof agentsDiscoverSchema>;

// Define the output type
interface AgentsDiscoverOutput {
    success: boolean;
    agentsFound: number;
    agents: Array<{
        eventId: string;
        name: string;
        role: string;
        description: string;
        useCriteria: string[];
        authorPubkey: string;
        createdAt: number;
    }>;
}

/**
 * Tool: agents_discover
 * Discover AgentDefinition events from the Nostr network
 */
export const agentsDiscover: Tool<AgentsDiscoverInput, AgentsDiscoverOutput> = {
    name: "agents_discover",
    description: "Discover agent definition events; these are agent definitions (system-prompt, use criteria, etc) that can be useful as experts",
    parameters: createZodSchema(agentsDiscoverSchema),
    execute: async (
        input: Validated<AgentsDiscoverInput>,
        context: ExecutionContext
    ): Promise<Result<ToolError, AgentsDiscoverOutput>> => {
        try {
            const { searchText, criteriaKeywords } = input.value;

            const ndk = getNDK();
            const discovery = new NDKAgentDiscovery(ndk);

            // Discover agents with specified filters
            const agents = await discovery.discoverAgents({
                searchText,
                criteriaKeywords,
            });

            // Format results
            const results = agents.map(agent => ({
                eventId: agent.id,
                name: agent.name,
                role: agent.role,
                description: agent.description,
                useCriteria: agent.useCriteria,
                authorPubkey: agent.authorPubkey,
                createdAt: agent.createdAt,
            }));

            logger.info(`Discovered ${results.length} AgentDefinition events`);

            return success({
                success: true,
                agentsFound: results.length,
                agents: results,
            });
        } catch (error) {
            logger.error("Failed to discover agents", { error });
            return failure({
                kind: "execution",
                tool: "agents_discover",
                message: error instanceof Error ? error.message : String(error),
                cause: error,
            });
        }
    },
};