import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { collectEvents } from "@/nostr/collectEvents";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKFilter } from "@nostr-dev-kit/ndk";

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
    async discoverAgents(options: AgentDiscoveryOptions = {}): Promise<NDKAgentDefinition[]> {
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

            const events = await collectEvents(this.ndk, filter, {
                subOpts: { groupable: false },
            });

            const discoveredAgents: NDKAgentDefinition[] = [];
            for (const event of events) {
                try {
                    discoveredAgents.push(NDKAgentDefinition.from(event));
                } catch (err) {
                    logger.warn("Failed to parse NDKAgentDefinition", { eventId: event.id, err });
                }
            }

            logger.info(`Found ${discoveredAgents.length} NDKAgentDefinition events`);

            // Apply local filtering if specified
            let filtered = discoveredAgents;

            if (options.searchText) {
                filtered = this.filterByText(filtered, options.searchText);
            }

            // Sort by creation time (newest first)
            filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

            return filtered;
        } catch (error) {
            logger.error("Failed to discover NDKAgentDefinition events", { error });
            throw error;
        }
    }

    /**
     * Filter agents by text search
     */
    private filterByText(agents: NDKAgentDefinition[], searchText: string): NDKAgentDefinition[] {
        const searchLower = searchText.toLowerCase();

        return agents.filter((agent) => {
            const searchableText = [
                agent.title || "",
                agent.role || "",
                agent.description || "",
                agent.useCriteria || "",
            ]
                .join(" ")
                .toLowerCase();

            return searchableText.includes(searchLower);
        });
    }
}
