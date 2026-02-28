/**
 * Canonical metadata key variants for RAG document filtering.
 *
 * Documents ingested via different code-paths use different key conventions:
 *   - Specialized services (reports, lessons, conversations) write **camelCase**.
 *   - The generic `rag_add_documents` tool historically wrote **snake_case**.
 *
 * Every SQL LIKE filter that matches on these keys must check BOTH variants
 * to avoid silently missing documents.  Keeping the pairs here as shared
 * constants prevents the two sets from drifting out of sync.
 */

/** Tuple of [camelCase, snake_case] key names for project ID metadata. */
export const PROJECT_ID_KEYS = ["projectId", "project_id"] as const;

/** Tuple of [camelCase, snake_case] key names for agent pubkey metadata. */
export const AGENT_PUBKEY_KEYS = ["agentPubkey", "agent_pubkey"] as const;
