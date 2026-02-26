/**
 * Centralized SQL project filter for RAG queries.
 *
 * Shared utility for the `metadata LIKE '%"projectId":"..."'` SQL prefilter pattern
 * used across all project-scoped RAG collections (reports, conversations, lessons).
 *
 * Applied DURING vector search (prefilter) to ensure proper project isolation.
 */

/**
 * Build a SQL prefilter string for project isolation in LanceDB queries.
 *
 * @param projectId - The project ID to filter by. Pass 'ALL' or undefined to skip filtering.
 * @returns SQL filter string or undefined if no filtering needed.
 */
export function buildProjectFilter(projectId?: string): string | undefined {
    if (!projectId || projectId.toLowerCase() === "all") {
        return undefined;
    }
    const escapedProjectId = projectId.replace(/'/g, "''");
    return `metadata LIKE '%"projectId":"${escapedProjectId}"%'`;
}
