import type NDK from "@nostr-dev-kit/ndk";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { logger } from "@/utils/logger";
import type { NDKFilter } from "@nostr-dev-kit/ndk";

/**
 * Discovered NDKAgentDefinition with metadata
 */
export interface DiscoveredAgent {
    /** NDKAgentDefinition event */
    event: NDKAgentDefinition;
    /** Event ID */
    id: string;
    /** Agent name/title */
    name: string;
    /** Agent role */
    role: string;
    /** Agent description */
    description?: string;
    /** Use criteria for routing */
    useCriteria?: string;
    /** Instructions for the agent */
    instructions?: string;
    /** Author pubkey */
    authorPubkey: string;
    /** Creation timestamp */
    createdAt?: number;
    /** Relevance score if filtered */
    relevanceScore?: number;
}

/**
 * Options for discovering NDKAgentDefinition events
 */
export interface AgentDiscoveryOptions {
    /** Text to search for in name/description/role */
    searchText?: string;
    /** Minimum creation timestamp */
    since?: number;
    /** Maximum creation timestamp */
    until?: number;
}

/**
 * Service for discovering NDKAgentDefinition events from the Nostr network
 */
export class NDKAgentDiscovery {
    constructor(private ndk: NDK) {}

    /**
     * Discover NDKAgentDefinition events from the network
     */
    async discoverAgents(options: AgentDiscoveryOptions = {}): Promise<DiscoveredAgent[]> {
        try {
            // Build filter for kind:4199 (NDKAgentDefinition)
            const filter: NDKFilter = {
                kinds: NDKAgentDefinition.kinds,
            };

            if (options.since) {
                filter.since = options.since;
            }
            if (options.until) {
                filter.until = options.until;
            }

            logger.debug("Discovering NDKAgentDefinition events", { filter });

            // Fetch events from network
            const events = await this.ndk.fetchEvents(filter, {
                closeOnEose: true,
                groupable: false,
            });

            logger.info(`Found ${events.size} NDKAgentDefinition events`);

            // Convert to NDKAgentDefinition instances and extract metadata
            const discoveredAgents: DiscoveredAgent[] = [];
            
            for (const event of Array.from(events)) {
                const ndkAgent = NDKAgentDefinition.from(event);
                
                const discovered: DiscoveredAgent = {
                    event: ndkAgent,
                    id: ndkAgent.id,
                    name: ndkAgent.title || "Unnamed Agent",
                    role: ndkAgent.role || "assistant",
                    description: ndkAgent.description,
                    useCriteria: ndkAgent.useCriteria,
                    instructions: ndkAgent.instructions || ndkAgent.content,
                    authorPubkey: ndkAgent.pubkey,
                    createdAt: ndkAgent.created_at,
                };

                discoveredAgents.push(discovered);
            }

            // Apply local filtering if specified
            let filtered = discoveredAgents;

            if (options.searchText) {
                filtered = this.filterByText(filtered, options.searchText);
            }

            // Sort by creation time (newest first)
            filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

            return filtered;
        } catch (error) {
            logger.error("Failed to discover NDKAgentDefinition events", { error });
            throw error;
        }
    }

    /**
     * Filter agents by text search
     */
    private filterByText(agents: DiscoveredAgent[], searchText: string): DiscoveredAgent[] {
        const searchLower = searchText.toLowerCase();
        
        return agents.filter(agent => {
            const searchableText = [
                agent.name,
                agent.role,
                agent.description || "",
                agent.useCriteria || ""
            ].join(" ").toLowerCase();
            
            return searchableText.includes(searchLower);
        });
    }
}