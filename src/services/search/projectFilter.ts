/**
 * Centralized SQL project filter for RAG queries.
 *
 * Shared utility for project-scoped metadata filtering across all RAG collections
 * (reports, conversations, lessons, and generic collections).
 *
 * Applied DURING vector search (prefilter) to ensure proper project isolation.
 *
 * Matches both "projectId" (canonical, used by specialized services) and
 * "project_id" (legacy, used by older rag_add_documents ingestion).
 */

/**
 * Build a SQL prefilter string for project isolation in LanceDB queries.
 *
 * Matches documents where metadata contains EITHER:
 *   - "projectId":"<id>" (canonical camelCase, used by specialized services)
 *   - "project_id":"<id>" (legacy snake_case, used by older rag_add_documents)
 *
 * @param projectId - The project ID to filter by. Pass 'ALL' or undefined to skip filtering.
 * @returns SQL filter string or undefined if no filtering needed.
 */
export function buildProjectFilter(projectId?: string): string | undefined {
    if (!projectId || projectId.toLowerCase() === "all") {
        return undefined;
    }
    const escapedProjectId = projectId.replace(/'/g, "''");
    // Match both camelCase (canonical) and snake_case (legacy) metadata keys
    return `(metadata LIKE '%"projectId":"${escapedProjectId}"%' OR metadata LIKE '%"project_id":"${escapedProjectId}"%')`;
}
