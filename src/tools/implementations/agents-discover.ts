import type { Tool, ExecutionContext, Result, ToolError, Validated, ParameterSchema } from "@/tools/types";
import { createZodSchema, success, failure } from "@/tools/types";
import { NDKAgentDiscovery } from "@/services/NDKAgentDiscovery";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import { z } from "zod";

// Define the input schema
const agentsDiscoverSchema = z.object({
    searchText: z.string().optional().describe("Text to search for in agent name/description/role"),
    limit: z.coerce.number().default(50).describe("Maximum number of agents to return"),
});


// Define the output type - returns markdown formatted string
interface AgentsDiscoverOutput {
    markdown: string;
    agentsFound: number;
}

/**
 * Tool: agents_discover
 * Discover AgentDefinition events from the Nostr network
 */
/**
 * Format discovered agents as markdown
 */
function formatAgentsAsMarkdown(agents: Array<{
  id: string;
  title: string;
  role: string;
  description?: string;
  useCriteria?: string;
  authorPubkey: string;
  createdAt?: number;
}>): string {
  if (agents.length === 0) {
    return "## No agents found\n\nNo agents match your search criteria. Try broadening your search or check back later.";
  }

  const lines: string[] = [];
  lines.push(`# Agent Discovery Results`);
  lines.push(`\nFound **${agents.length}** available agent${agents.length === 1 ? '' : 's'}:\n`);

  agents.forEach((agent, index) => {
    lines.push(`## ${index + 1}. ${agent.title}`);
    lines.push(`nostr:${agent.id}`);
    lines.push(``);
    
    lines.push(`---`);
    lines.push(``);
  });

  return lines.join('\n');
}

export const agentsDiscover: Tool<z.input<typeof agentsDiscoverSchema>, AgentsDiscoverOutput> = {
    name: "agents_discover",
    description: "Discover agent definition events; these are agent definitions (system-prompt, use criteria, etc) that can be useful as experts",
    promptFragment: `When showing the agents to the user, just use their nostr:id, the frontend will display them properly. You cannot use agents directly, you can only suggest them to the user.`,
    parameters: createZodSchema(agentsDiscoverSchema) as ParameterSchema<z.input<typeof agentsDiscoverSchema>>,
    execute: async (
        input: Validated<z.input<typeof agentsDiscoverSchema>>,
        _context: ExecutionContext
    ): Promise<Result<ToolError, AgentsDiscoverOutput>> => {
        try {
            const { searchText, limit = 50 } = input.value;

            const ndk = getNDK();
            const discovery = new NDKAgentDiscovery(ndk);

            // Discover agents with specified filters
            const agents = await discovery.discoverAgents({
                searchText,
            });

            // Format results with bech32 encoded IDs
            let results = agents.map(agent => {
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

            return success({
                markdown,
                agentsFound: results.length,
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