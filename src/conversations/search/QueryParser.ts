/**
 * QueryParser - Pure function for parsing and validating search queries.
 *
 * Handles:
 * - Text query validation (required, non-empty)
 * - Agent filter parsing (string array)
 * - Date filter parsing (Unix timestamps or ISO 8601 strings)
 * - 'after' is a pure alias for 'since' (since takes precedence if both provided)
 */

import type { SearchFilters, SearchQuery } from "./types";

/**
 * Input format from the tool schema.
 */
export interface RawSearchInput {
    query: string;
    filters?: {
        agents?: string[];
        since?: string | number;
        after?: string | number;
    };
}

/**
 * Parse a date input to Unix timestamp in seconds.
 * Accepts:
 * - Unix timestamp (number or numeric string) in seconds
 * - ISO 8601 date strings (e.g., "2026-01-26T10:00:00Z")
 * - Date-only strings (e.g., "2026-01-26")
 *
 * @throws Error if the date cannot be parsed
 */
export function parseTimestamp(value: string | number): number {
    if (typeof value === "number") {
        // Assume it's already Unix seconds
        return value;
    }

    // Try parsing as numeric string (Unix timestamp)
    const numericValue = Number(value);
    if (!isNaN(numericValue) && value.trim() === String(numericValue)) {
        return numericValue;
    }

    // Try parsing as date string
    const date = new Date(value);
    if (isNaN(date.getTime())) {
        throw new Error(`Invalid date format: "${value}". Expected Unix timestamp or ISO 8601 date.`);
    }

    // Convert to Unix seconds
    return Math.floor(date.getTime() / 1000);
}

/**
 * Parse and validate a raw search input into a SearchQuery.
 *
 * @throws Error if validation fails
 */
export function parseQuery(input: RawSearchInput): SearchQuery {
    // Validate query text
    if (!input.query || typeof input.query !== "string") {
        throw new Error("Search query is required and must be a non-empty string.");
    }

    const trimmedQuery = input.query.trim();
    if (trimmedQuery.length === 0) {
        throw new Error("Search query cannot be empty.");
    }

    // Parse filters
    const filters: SearchFilters = {};

    if (input.filters) {
        // Parse agents filter
        if (input.filters.agents !== undefined) {
            if (!Array.isArray(input.filters.agents)) {
                throw new Error("filters.agents must be an array of strings.");
            }
            const validAgents = input.filters.agents.filter(
                (a): a is string => typeof a === "string" && a.trim().length > 0
            );
            if (validAgents.length > 0) {
                filters.agents = validAgents.map((a) => a.trim());
            }
        }

        // Parse since filter (primary)
        if (input.filters.since !== undefined) {
            filters.since = parseTimestamp(input.filters.since);
        }

        // Parse after filter as pure alias for since
        // If since is already set, ignore after (since takes precedence)
        if (input.filters.after !== undefined && filters.since === undefined) {
            filters.since = parseTimestamp(input.filters.after);
        }
        // Note: We don't store 'after' separately - it's just an alias for 'since'
    }

    return {
        text: trimmedQuery,
        filters,
    };
}

/**
 * Get the "since" timestamp from filters.
 * Note: 'after' is already resolved to 'since' during parsing.
 */
export function getEffectiveSinceTimestamp(filters: SearchFilters): number | undefined {
    return filters.since;
}
