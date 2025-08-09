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
 * Options for discovering NDKAgent events
 */
export interface AgentDiscoveryOptions {
    /** Filter by authors */
    authors?: string[];
    /** Maximum number of results */
    limit?: number;
    /** Text to search for in name/description/role */
    searchText?: string;
    /** Keywords to match in useCriteria */
    criteriaKeywords?: string[];
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
                kinds: [4199],
                limit: options.limit || 100,
            };

            // Add optional filters
            if (options.authors?.length) {
                filter.authors = options.authors;
            }
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
            
            for (const event of events) {
                const ndkAgent = NDKAgentDefinition.from(event);
                
                const discovered: DiscoveredAgent = {
                    event: ndkAgent,
                    id: ndkAgent.id,
                    name: ndkAgent.name || "Unnamed Agent",
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

            if (options.criteriaKeywords?.length) {
                filtered = this.filterByCriteria(filtered, options.criteriaKeywords);
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
     * Find agents that match specific role requirements
     */
    async findAgentsByRole(roleKeywords: string[]): Promise<DiscoveredAgent[]> {
        const agents = await this.discoverAgents();
        
        return agents.filter(agent => {
            const roleText = (agent.role || "").toLowerCase();
            const descText = (agent.description || "").toLowerCase();
            
            return roleKeywords.some(keyword => 
                roleText.includes(keyword.toLowerCase()) || 
                descText.includes(keyword.toLowerCase())
            );
        });
    }

    /**
     * Find agents by specific author
     */
    async findAgentsByAuthor(authorPubkey: string): Promise<DiscoveredAgent[]> {
        return this.discoverAgents({ authors: [authorPubkey] });
    }

    /**
     * Get agent recommendations based on task description
     */
    async getAgentRecommendations(taskDescription: string): Promise<DiscoveredAgent[]> {
        const agents = await this.discoverAgents();
        
        // Score agents based on relevance to task
        const scored = agents.map(agent => {
            let score = 0;
            const taskLower = taskDescription.toLowerCase();
            
            // Check name relevance
            if (agent.name.toLowerCase().includes(taskLower)) {
                score += 3;
            }
            
            // Check role relevance
            const roleLower = (agent.role || "").toLowerCase();
            const taskWords = taskLower.split(/\s+/);
            taskWords.forEach(word => {
                if (word.length > 3 && roleLower.includes(word)) {
                    score += 2;
                }
            });
            
            // Check useCriteria relevance
            const criteriaLower = (agent.useCriteria || "").toLowerCase();
            taskWords.forEach(word => {
                if (word.length > 3 && criteriaLower.includes(word)) {
                    score += 1;
                }
            });
            
            // Check description relevance
            const descLower = (agent.description || "").toLowerCase();
            taskWords.forEach(word => {
                if (word.length > 3 && descLower.includes(word)) {
                    score += 1;
                }
            });
            
            return {
                ...agent,
                relevanceScore: score
            };
        });
        
        // Filter out agents with no relevance and sort by score
        return scored
            .filter(agent => agent.relevanceScore! > 0)
            .sort((a, b) => b.relevanceScore! - a.relevanceScore!);
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

    /**
     * Filter agents by criteria keywords
     */
    private filterByCriteria(agents: DiscoveredAgent[], keywords: string[]): DiscoveredAgent[] {
        return agents.filter(agent => {
            const criteriaLower = (agent.useCriteria || "").toLowerCase();
            return keywords.some(keyword => 
                criteriaLower.includes(keyword.toLowerCase())
            );
        });
    }

    /**
     * Get detailed information about a specific NDKAgentDefinition
     */
    async getAgentDetails(eventId: string): Promise<DiscoveredAgent | null> {
        try {
            const filter: NDKFilter = {
                ids: [eventId],
                kinds: [4199],
            };

            const event = await this.ndk.fetchEvent(filter, {
                closeOnEose: true,
                groupable: false,
            });

            if (!event) {
                return null;
            }

            const ndkAgent = NDKAgentDefinition.from(event);
            
            return {
                event: ndkAgent,
                id: ndkAgent.id,
                name: ndkAgent.name || "Unnamed Agent",
                role: ndkAgent.role || "assistant",
                description: ndkAgent.description,
                useCriteria: ndkAgent.useCriteria,
                instructions: ndkAgent.instructions || ndkAgent.content,
                authorPubkey: ndkAgent.pubkey,
                createdAt: ndkAgent.created_at,
            };
        } catch (error) {
            logger.error(`Failed to fetch agent details for ${eventId}`, { error });
            return null;
        }
    }
}