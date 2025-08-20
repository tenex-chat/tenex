import type NDK from "@nostr-dev-kit/ndk";
import type { NDKFilter } from "@nostr-dev-kit/ndk";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { logger } from "@/utils/logger";

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

      // Fetch events from network
      const events = await this.ndk.fetchEvents(filter, {
        closeOnEose: true,
        groupable: false,
      });

      logger.info(`Found ${events.size} NDKAgentDefinition events`);

      // Convert to NDKAgentDefinition instances
      const discoveredAgents: NDKAgentDefinition[] = [];

      for (const event of Array.from(events)) {
        const ndkAgent = NDKAgentDefinition.from(event);
        discoveredAgents.push(ndkAgent);
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
