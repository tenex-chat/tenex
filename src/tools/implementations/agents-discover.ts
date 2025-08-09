import type { Tool, ToolFunction } from "@/tools/types";
import { NDKAgentDiscovery } from "@/services/NDKAgentDiscovery";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import { z } from "zod";

/**
 * Tool function to discover NDKAgent events from the Nostr network
 */
const agentsDiscoverTool: ToolFunction = async (args) => {
    try {
        const { 
            searchText, 
            roleKeywords, 
            criteriaKeywords, 
            authorPubkey,
            limit 
        } = args as {
            searchText?: string;
            roleKeywords?: string[];
            criteriaKeywords?: string[];
            authorPubkey?: string;
            limit?: number;
        };

        const ndk = getNDK();
        const discovery = new NDKAgentDiscovery(ndk);

        // Discover agents with specified filters
        const agents = await discovery.discoverAgents({
            searchText,
            criteriaKeywords,
            authors: authorPubkey ? [authorPubkey] : undefined,
            limit: limit || 50,
        });

        // Apply role filtering if specified
        let filtered = agents;
        if (roleKeywords?.length) {
            filtered = agents.filter(agent => {
                const roleText = (agent.role || "").toLowerCase();
                const descText = (agent.description || "").toLowerCase();
                
                return roleKeywords.some(keyword => 
                    roleText.includes(keyword.toLowerCase()) || 
                    descText.includes(keyword.toLowerCase())
                );
            });
        }

        // Format results
        const results = filtered.map(agent => ({
            eventId: agent.id,
            name: agent.name,
            role: agent.role,
            description: agent.description,
            useCriteria: agent.useCriteria,
            authorPubkey: agent.authorPubkey,
            createdAt: agent.createdAt,
        }));

        logger.info(`Discovered ${results.length} NDKAgent events`);

        return {
            success: true,
            agentsFound: results.length,
            agents: results,
        };
    } catch (error) {
        logger.error("Failed to discover agents", { error });
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            agents: [],
        };
    }
};

/**
 * Tool: agents_discover
 * Discover NDKAgent events from the Nostr network
 */
export const agentsDiscover: Tool = {
    name: "agents_discover",
    description: "Discover NDKAgent events from the Nostr network based on search criteria",
    parameters: z.object({
        searchText: z.string().optional().describe("Text to search for in agent name/description/role"),
        roleKeywords: z.array(z.string()).optional().describe("Keywords to match in agent role"),
        criteriaKeywords: z.array(z.string()).optional().describe("Keywords to match in agent use criteria"),
        authorPubkey: z.string().optional().describe("Filter by specific author pubkey"),
        limit: z.number().optional().describe("Maximum number of results (default: 50)"),
    }),
    handler: agentsDiscoverTool,
};