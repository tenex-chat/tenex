import { NDKKind } from "@/nostr/kinds";
import type { Hexpubkey, NDKFilter } from "@nostr-dev-kit/ndk";

/**
 * Static utility class for building NDK subscription filters.
 *
 * Each method builds filters for one independent subscription group.
 * The SubscriptionManager calls these individually rather than
 * combining them into a single monolithic filter set.
 */
export class SubscriptionFilterBuilder {
    /**
     * Build filters for the static subscription (created once at boot, never recreated).
     * Includes:
     * - Project discovery (kind 31933) from whitelisted pubkeys
     * - Agent config updates (kind 24020) from whitelisted pubkeys
     * - Lesson comments (kind 1111, #K: 4129) from whitelisted pubkeys
     */
    static buildStaticFilters(whitelistedPubkeys: Set<Hexpubkey>): NDKFilter[] {
        if (whitelistedPubkeys.size === 0) {
            return [];
        }

        const authors = Array.from(whitelistedPubkeys);

        return [
            // Project discovery + agent config updates + agent deletions
            {
                kinds: [31933, NDKKind.TenexAgentConfigUpdate, NDKKind.TenexAgentDelete],
                authors,
            },
            // Lesson comments from whitelisted authors
            // No #p filter — the Daemon uses the E tag to route to the correct agent
            {
                kinds: [NDKKind.Comment],
                "#K": [String(NDKKind.AgentLesson)],
                authors,
            },
        ];
    }

    /**
     * Build filter for events tagging known projects via A-tags
     * Receives all events tagged to our projects — the Daemon decides
     * which events can boot a cold project vs which require a running one
     * @param knownProjects - Set of project IDs (format: "31933:authorPubkey:dTag")
     * @param since - Optional Unix timestamp (seconds) to filter out historical events
     * @returns NDKFilter for project-tagged events or null if no projects
     */
    static buildProjectTaggedFilter(knownProjects: Set<string>, since?: number): NDKFilter | null {
        if (knownProjects.size === 0) {
            return null;
        }

        const filter: NDKFilter = {
            "#a": Array.from(knownProjects),
            limit: 0,
        };

        if (since !== undefined) {
            filter.since = since;
        }

        return filter;
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
            kinds: [30023],
            "#a": Array.from(knownProjects),
        };
    }

    /**
     * Build filter for events mentioning agents via P-tags
     * @param agentPubkeys - Set of agent pubkeys to monitor
     * @param since - Optional Unix timestamp (seconds) to filter out historical events
     * @returns NDKFilter for agent mentions or null if no agents
     */
    static buildAgentMentionsFilter(agentPubkeys: Set<Hexpubkey>, since?: number): NDKFilter | null {
        if (agentPubkeys.size === 0) {
            return null;
        }

        const filter: NDKFilter = {
            "#p": Array.from(agentPubkeys),
            limit: 0,
        };

        if (since !== undefined) {
            filter.since = since;
        }

        return filter;
    }

    /**
     * Build filter for a single agent's lessons by definition event ID.
     * Uses #e tag to match lessons that reference the agent definition.
     * @param definitionId - Agent definition event ID
     * @returns NDKFilter for this agent's lessons
     */
    static buildLessonFilter(definitionId: string): NDKFilter {
        return {
            kinds: [NDKKind.AgentLesson],
            "#e": [definitionId],
        };
    }
}
