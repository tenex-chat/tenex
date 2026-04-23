import { NDKKind } from "@/nostr/kinds";
import type { Hexpubkey, NDKFilter } from "@nostr-dev-kit/ndk";

/**
 * Build filters for the static subscription (created once at boot, never recreated).
 *
 * Split into two groups to control historical data volume:
 * - Project discovery (kind 31933, replaceable) — no `since`, relay returns latest per d-tag
 * - Operational events (config updates, deletions, lesson comments) — bounded by `since`
 *   because historical data is already loaded from local storage at boot
 *
 * @param whitelistedPubkeys - Pubkeys to monitor
 * @param since - Unix timestamp (seconds) bounding operational events
 */
export function buildStaticFilters(whitelistedPubkeys: Set<Hexpubkey>, since?: number): NDKFilter[] {
    if (whitelistedPubkeys.size === 0) {
        return [];
    }

    const authors = Array.from(whitelistedPubkeys);

    const filters: NDKFilter[] = [
        // Project discovery — replaceable events, relay sends latest per d-tag
        {
            kinds: [31933],
            authors,
        },
    ];

    // Operational events — bounded by since to avoid replaying history
    const opsFilter: NDKFilter = {
        kinds: [
            NDKKind.TenexAgentConfigUpdate,
            NDKKind.TenexAgentDelete,
        ],
        authors,
    };
    if (since !== undefined) {
        opsFilter.since = since;
    }
    filters.push(opsFilter);

    // Lesson comments from whitelisted authors
    // No #p filter — the Daemon uses the E tag to route to the correct agent
    const lessonFilter: NDKFilter = {
        kinds: [NDKKind.Comment],
        "#K": [String(NDKKind.AgentLesson)],
        authors,
    };
    if (since !== undefined) {
        lessonFilter.since = since;
    }
    filters.push(lessonFilter);

    return filters;
}

/**
 * Build filter for events tagging known projects via A-tags
 * Receives all events tagged to our projects — the Daemon decides
 * which events can boot a cold project vs which require a running one
 * @param knownProjects - Set of project IDs (format: "31933:authorPubkey:dTag")
 * @param since - Optional Unix timestamp (seconds) to filter out historical events
 * @returns NDKFilter for project-tagged events or null if no projects
 */
export function buildProjectTaggedFilter(knownProjects: Set<string>, since?: number): NDKFilter | null {
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
 * Build filter for events mentioning agents via P-tags
 * @param agentPubkeys - Set of agent pubkeys to monitor
 * @param since - Optional Unix timestamp (seconds) to filter out historical events
 * @returns NDKFilter for agent mentions or null if no agents
 */
export function buildAgentMentionsFilter(agentPubkeys: Set<Hexpubkey>, since?: number): NDKFilter | null {
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
export function buildLessonFilter(definitionId: string): NDKFilter {
    return {
        kinds: [NDKKind.AgentLesson],
        "#e": [definitionId],
    };
}
