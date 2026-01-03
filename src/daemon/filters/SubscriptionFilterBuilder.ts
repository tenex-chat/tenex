import { NDKKind } from "@/nostr/kinds";
import type { Hexpubkey, NDKFilter } from "@nostr-dev-kit/ndk";

/**
 * Configuration for building subscription filters
 */
export interface SubscriptionConfig {
    /** Whitelisted pubkeys that can create/manage projects */
    whitelistedPubkeys: Set<Hexpubkey>;
    /** Known project A-tags (format: "31933:authorPubkey:dTag") */
    knownProjects: Set<string>;
    /** Agent pubkeys across all projects */
    agentPubkeys: Set<Hexpubkey>;
    /** Agent definition event IDs for lesson monitoring */
    agentDefinitionIds: Set<string>;
}

/**
 * Static utility class for building NDK subscription filters.
 * Follows the AgentEventDecoder pattern of static utility methods.
 */
export class SubscriptionFilterBuilder {
    /**
     * Build all subscription filters from configuration
     * @param config - Subscription configuration
     * @returns Array of NDKFilter objects for subscription
     */
    static buildFilters(config: SubscriptionConfig): NDKFilter[] {
        const filters: NDKFilter[] = [];

        // Add project events filter
        const projectFilter = this.buildProjectFilter(config.whitelistedPubkeys);
        if (projectFilter) {
            filters.push(projectFilter);
        }

        // Add project-tagged events filter
        const projectTaggedFilter = this.buildProjectTaggedFilter(config.knownProjects);
        if (projectTaggedFilter) {
            filters.push(projectTaggedFilter);
        }

        // Add agent mentions filter
        const agentMentionsFilter = this.buildAgentMentionsFilter(config.agentPubkeys);
        if (agentMentionsFilter) {
            filters.push(agentMentionsFilter);
        }

        // Add lesson filters
        const lessonFilters = this.buildLessonFilters(
            config.agentPubkeys,
            config.agentDefinitionIds
        );
        filters.push(...lessonFilters);

        // Add report filter
        const reportFilter = this.buildReportFilter(config.knownProjects);
        if (reportFilter) {
            filters.push(reportFilter);
        }

        return filters;
    }

    /**
     * Build filter for project events (kind 31933) from whitelisted pubkeys
     * This ensures we receive project creation and update events
     * @param whitelistedPubkeys - Set of whitelisted author pubkeys
     * @returns NDKFilter for project events or null if no pubkeys
     */
    static buildProjectFilter(whitelistedPubkeys: Set<Hexpubkey>): NDKFilter | null {
        if (whitelistedPubkeys.size === 0) {
            return null;
        }

        return {
            kinds: [31933], // Project events
            authors: Array.from(whitelistedPubkeys),
        };
    }

    /**
     * Build filter for events tagging known projects via A-tags
     * Receives all events tagged to our projects - the Daemon decides
     * which events can boot a cold project vs which require a running one
     * @param knownProjects - Set of project IDs (format: "31933:authorPubkey:dTag")
     * @returns NDKFilter for project-tagged events or null if no projects
     */
    static buildProjectTaggedFilter(knownProjects: Set<string>): NDKFilter | null {
        if (knownProjects.size === 0) {
            return null;
        }

        return {
            "#a": Array.from(knownProjects),
            limit: 0, // Continuous subscription
        };
    }

    /**
     * Build filter for events mentioning agents via P-tags
     * Receives all events mentioning our agents - the Daemon decides
     * which events can boot a cold project vs which require a running one
     * @param agentPubkeys - Set of agent pubkeys to monitor
     * @returns NDKFilter for agent mentions or null if no agents
     */
    static buildAgentMentionsFilter(agentPubkeys: Set<Hexpubkey>): NDKFilter | null {
        if (agentPubkeys.size === 0) {
            return null;
        }

        return {
            "#p": Array.from(agentPubkeys),
            limit: 0, // Continuous subscription
        };
    }

    /**
     * Build filters for agent lessons
     * Monitors both:
     * - Lessons published by our agents
     * - Lessons referencing our agent definitions (via e-tag)
     * @param agentPubkeys - Set of agent pubkeys (for authored lessons)
     * @param agentDefinitionIds - Set of agent definition event IDs (for referenced lessons)
     * @returns Array of NDKFilter objects for lesson monitoring
     */
    static buildLessonFilters(
        agentPubkeys: Set<Hexpubkey>,
        agentDefinitionIds: Set<string>
    ): NDKFilter[] {
        const filters: NDKFilter[] = [];

        // Filter for lessons authored by our agents
        if (agentPubkeys.size > 0) {
            filters.push({
                kinds: [NDKKind.AgentLesson],
                authors: Array.from(agentPubkeys),
            });
        }

        // Filter for lessons referencing our agent definitions
        if (agentDefinitionIds.size > 0) {
            filters.push({
                kinds: [NDKKind.AgentLesson],
                "#e": Array.from(agentDefinitionIds),
            });
        }

        return filters;
    }

    /**
     * Build filter for report events (kind 30023 - NDKArticle)
     * Monitors reports tagged with our project
     * @param knownProjects - Set of project A-tags (format: "31933:authorPubkey:dTag")
     * @returns NDKFilter for report events or null if no projects
     */
    static buildReportFilter(knownProjects: Set<string>): NDKFilter | null {
        if (knownProjects.size === 0) {
            return null;
        }

        return {
            kinds: [30023], // NDKArticle kind - reports
            "#a": Array.from(knownProjects), // Reports tagged with our project(s)
        };
    }

    /**
     * Compare two filter sets to determine if they're equivalent
     * @param filters1 - First set of filters
     * @param filters2 - Second set of filters
     * @returns True if filters are equivalent
     */
    static areFiltersEqual(filters1: NDKFilter[], filters2: NDKFilter[]): boolean {
        if (filters1.length !== filters2.length) {
            return false;
        }

        // Sort filters by JSON representation for comparison
        const sorted1 = filters1.map((f) => JSON.stringify(f)).sort();
        const sorted2 = filters2.map((f) => JSON.stringify(f)).sort();

        return sorted1.every((f, i) => f === sorted2[i]);
    }

    /**
     * Debug helper: Get human-readable description of filters
     * @param filters - Array of NDKFilter objects
     * @returns Object with filter statistics
     */
    static getFilterStats(filters: NDKFilter[]): {
        totalFilters: number;
        projectFilter: boolean;
        projectTaggedCount: number;
        agentMentionsCount: number;
        lessonFilters: number;
        reportFilter: boolean;
    } {
        let projectFilter = false;
        let projectTaggedCount = 0;
        let agentMentionsCount = 0;
        let lessonFilters = 0;
        let reportFilter = false;

        for (const filter of filters) {
            if (filter.kinds?.includes(31933)) {
                projectFilter = true;
            }
            if (filter["#a"] && !filter.kinds?.includes(30023)) {
                projectTaggedCount = (filter["#a"] as string[]).length;
            }
            if (filter["#p"]) {
                agentMentionsCount = (filter["#p"] as string[]).length;
            }
            if (filter.kinds?.includes(NDKKind.AgentLesson)) {
                lessonFilters++;
            }
            if (filter.kinds?.includes(30023)) {
                reportFilter = true;
            }
        }

        return {
            totalFilters: filters.length,
            projectFilter,
            projectTaggedCount,
            agentMentionsCount,
            lessonFilters,
            reportFilter,
        };
    }
}