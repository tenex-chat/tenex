import { getNDK } from "@/nostr";
import { NDKAgentDiscovery } from "@/services/NDKAgentDiscovery";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
const agentsDiscoverSchema = z.object({
    searchText: z.string().nullable().describe("Text to search for in agent name/description/role"),
    limit: z.coerce.number().default(50).describe("Maximum number of agents to return"),
});

type AgentsDiscoverInput = z.infer<typeof agentsDiscoverSchema>;
type AgentsDiscoverOutput = {
    markdown: string;
    agentsFound: number;
};

/**
 * Format discovered agents as markdown
 */
function formatAgentsAsMarkdown(
    agents: Array<{
        id: string;
        title: string;
        role: string;
        description?: string;
        useCriteria?: string;
        authorPubkey: string;
        createdAt?: number;
    }>
): string {
    if (agents.length === 0) {
        return "## No agents found\n\nNo agents match your search criteria. Try broadening your search or check back later.";
    }

    const lines: string[] = [];
    lines.push("# Agent Discovery Results");
    lines.push(`\nFound **${agents.length}** available agent${agents.length === 1 ? "" : "s"}:\n`);

    for (const [index, agent] of agents.entries()) {
        lines.push(`## ${index + 1}. ${agent.title}`);
        lines.push(`nostr:${agent.id}`);
        lines.push("");

        lines.push("---");
        lines.push("");
    }

    return lines.join("\n");
}

/**
 * Core implementation of the agents_discover functionality
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeAgentsDiscover(input: AgentsDiscoverInput): Promise<AgentsDiscoverOutput> {
    const { searchText, limit = 50 } = input;

    const ndk = getNDK();
    const discovery = new NDKAgentDiscovery(ndk);

    // Discover agents with specified filters
    const agents = await discovery.discoverAgents({
        searchText,
    });

    // Format results with bech32 encoded IDs
    let results = agents.map((agent) => {
        // Get bech32 encoded ID from the NDKAgentDefinition event
        const bech32Id = agent.encode();

        return {
            id: bech32Id,
            title: agent.title || "Unnamed Agent",
            role: agent.role || "assistant",
            description: agent.description,
            useCriteria: agent.useCriteria,
            authorPubkey: agent.pubkey,
            createdAt: agent.created_at,
        };
    });

    // Apply limit if specified
    if (limit && results.length > limit) {
        results = results.slice(0, limit);
    }

    logger.info(`Returning ${results.length} AgentDefinition events after limiting`);

    // Format as markdown
    const markdown = formatAgentsAsMarkdown(results);

    return {
        markdown,
        agentsFound: results.length,
    };
}

/**
 * Create an AI SDK tool for discovering agents
 * This is the primary implementation
 */
export function createAgentsDiscoverTool(): ReturnType<typeof tool> {
    return tool({
        description:
            "Discover agent definition events; these are agent definitions that can be useful to be installed in the project. Use this when trying to discover NEW possible agents to add to the project NOT to see the list of current agents in the project.",
        inputSchema: agentsDiscoverSchema,
        execute: async (input: AgentsDiscoverInput) => {
            try {
                return await executeAgentsDiscover(input);
            } catch (error) {
                logger.error("Failed to discover agents", { error });
                throw new Error(
                    `Failed to discover agents: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        },
    });
}
