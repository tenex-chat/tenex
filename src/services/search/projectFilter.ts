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

import { PROJECT_ID_KEYS } from "@/utils/metadataKeys";
import { SQL_LIKE_ESCAPE_CLAUSE, escapeSqlLikeValue } from "@/utils/sqlEscaping";

/**
 * Build a SQL prefilter string for project isolation in LanceDB queries.
 *
 * Matches documents where metadata contains EITHER:
 *   - "projectId":"<id>" (canonical camelCase, used by specialized services)
 *   - "project_id":"<id>" (legacy snake_case, used by older rag_add_documents)
 *
 * Uses proper SQL LIKE escaping so that project IDs containing wildcards
 * (%, _) or quotes don't broaden or break the filter.
 *
 * @param projectId - The project ID to filter by. Pass 'ALL' or undefined to skip filtering.
 * @returns SQL filter string or undefined if no filtering needed.
 */
export function buildProjectFilter(projectId?: string): string | undefined {
    if (!projectId || projectId.toLowerCase() === "all") {
        return undefined;
    }
    const escaped = escapeSqlLikeValue(projectId);
    const clauses = PROJECT_ID_KEYS
        .map((key) => `metadata LIKE '%"${key}":"${escaped}"%' ${SQL_LIKE_ESCAPE_CLAUSE}`)
        .join(" OR ");
    return `(${clauses})`;
}
