import type { ProjectContext } from "@/services/projects/ProjectContext";
import { logger } from "@/utils/logger";

type AgentResolutionProjectContext = Pick<ProjectContext, "agentRegistry"> &
    Partial<Pick<ProjectContext, "getProjectAgentRuntimeInfo">>;

/**
 * Result of resolving an agent slug
 */
export interface AgentResolutionResult {
    pubkey: string | null;
    availableSlugs: string[];
}

/**
 * Resolve an agent slug to a pubkey.
 *
 * ONLY accepts agent slugs (e.g., "architect", "claude-code").
 * Does NOT support: pubkeys, npubs, nprofiles, hex prefixes, or agent names.
 *
 * @param slug - Agent slug (case-insensitive)
 * @param projectContext - Explicit project-scoped agent lookup context
 * @returns Resolution result with pubkey (or null) and list of available slugs
 */
export function resolveAgentSlug(
    slug: string,
    projectContext?: AgentResolutionProjectContext
): AgentResolutionResult {
    const trimmedSlug = slug.trim();
    const slugLower = trimmedSlug.toLowerCase();

    if (!projectContext) {
        logger.debug("resolveAgentSlug called without project context", { slug: trimmedSlug });
        return { pubkey: null, availableSlugs: [] };
    }

    try {
        const agents = typeof projectContext.getProjectAgentRuntimeInfo === "function"
            ? projectContext.getProjectAgentRuntimeInfo()
            : Array.from(projectContext.agentRegistry.getAllAgentsMap().entries()).map(
                ([agentSlug, agent]) => ({
                    slug: agentSlug,
                    pubkey: agent.pubkey,
                })
            );

        const availableSlugs = agents.map((agent) => agent.slug);

        for (const agent of agents) {
            if (agent.slug.toLowerCase() === slugLower) {
                return { pubkey: agent.pubkey, availableSlugs };
            }
        }

        logger.debug("Agent slug not found", { slug: trimmedSlug, availableSlugs });
        return { pubkey: null, availableSlugs };
    } catch (error) {
        logger.debug("Failed to resolve agent slug", { slug: trimmedSlug, error });
        return { pubkey: null, availableSlugs: [] };
    }
}

/**
 * @deprecated Use resolveAgentSlug instead for the full resolution result with available slugs.
 * This wrapper is kept for callers that only need the pubkey without error context.
 *
 * Resolve an agent slug to a pubkey (simplified interface).
 *
 * @param slug - Agent slug (case-insensitive)
 * @param projectContext - Explicit project-scoped agent lookup context
 * @returns Pubkey hex string or null if not found
 */
export function resolveRecipientToPubkey(
    slug: string,
    projectContext?: AgentResolutionProjectContext
): string | null {
    const result = resolveAgentSlug(slug, projectContext);
    return result.pubkey;
}
