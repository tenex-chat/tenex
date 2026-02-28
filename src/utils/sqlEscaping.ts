/**
 * SQL escaping utilities for LanceDB metadata LIKE queries.
 *
 * Shared across all RAG query builders (project filters, agent stats, etc.)
 * to ensure consistent escaping of user-supplied values in SQL LIKE patterns.
 *
 * IMPORTANT: DataFusion (used by LanceDB) has NO default escape character.
 * Backslash-based escapes only work when paired with an ESCAPE '\\' clause.
 * See: https://github.com/apache/datafusion/issues/13291
 */

/**
 * The ESCAPE clause literal required by every LIKE expression that uses
 * the backslash escapes produced by {@link escapeSqlLikeValue}.
 *
 * Usage: `metadata LIKE '…${escaped}…' ${SQL_LIKE_ESCAPE_CLAUSE}`
 */
export const SQL_LIKE_ESCAPE_CLAUSE = "ESCAPE '\\\\'";

/**
 * Escape a string for use inside a SQL LIKE pattern.
 *
 * Escapes: backslashes (\), single quotes ('), double quotes ("),
 * and LIKE wildcards (%, _).
 *
 * The returned value MUST be used together with {@link SQL_LIKE_ESCAPE_CLAUSE}
 * so that DataFusion recognises the backslash as the escape character.
 *
 * @param value - Raw string to escape (e.g. a project ID or agent pubkey).
 * @returns Escaped string safe for interpolation into a LIKE pattern.
 */
export function escapeSqlLikeValue(value: string): string {
    return value
        .replace(/\\/g, "\\\\")  // Escape backslashes first
        .replace(/'/g, "''")     // SQL standard: escape single quote by doubling
        .replace(/"/g, '\\"')    // Escape double quotes
        .replace(/%/g, "\\%")    // Escape LIKE wildcard %
        .replace(/_/g, "\\_");   // Escape LIKE wildcard _
}
