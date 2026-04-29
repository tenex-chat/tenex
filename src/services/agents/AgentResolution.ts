import { getProjectContext } from "@/services/projects";
import { prefixKVStore } from "@/services/storage";
import {
    parseNostrUser,
    PUBKEY_DISPLAY_LENGTH,
    STORAGE_PREFIX_LENGTH,
} from "@/utils/nostr-entity-parser";
import { logger } from "@/utils/logger";

/**
 * Result of resolving an agent id.
 */
export interface AgentResolutionResult {
    pubkey: string | null;
    slug: string | null;
    availableIds: string[];
    availableSlugs: string[];
    failureReason?: "not_found" | "ambiguous";
}

export interface AgentIdCandidate {
    pubkey: string;
    slug: string;
}

function normalizeCandidate(agent: { pubkey?: string; slug?: string }, fallbackSlug?: string): AgentIdCandidate | null {
    const pubkey = agent.pubkey?.trim();
    const slug = agent.slug?.trim() || fallbackSlug?.trim();
    if (!pubkey || !slug) {
        return null;
    }
    return { pubkey, slug };
}

function dedupeCandidates(candidates: AgentIdCandidate[]): AgentIdCandidate[] {
    const byPubkey = new Map<string, AgentIdCandidate>();
    for (const candidate of candidates) {
        const key = candidate.pubkey.toLowerCase();
        if (!byPubkey.has(key)) {
            byPubkey.set(key, candidate);
        }
    }
    return Array.from(byPubkey.values());
}

function getProjectAgentCandidates(): AgentIdCandidate[] {
    const projectContext = getProjectContext();

    if (typeof projectContext.getProjectAgentRuntimeInfo === "function") {
        return dedupeCandidates(
            projectContext.getProjectAgentRuntimeInfo()
                .map((agent) => normalizeCandidate(agent))
                .filter((agent): agent is AgentIdCandidate => agent !== null)
        );
    }

    const registry = projectContext.agentRegistry;
    const candidates: AgentIdCandidate[] = [];

    if (typeof registry.getAllProjectAgents === "function") {
        for (const agent of registry.getAllProjectAgents()) {
            const candidate = normalizeCandidate(agent);
            if (candidate) {
                candidates.push(candidate);
            }
        }
    }

    const agentMap = registry.getAllAgentsMap();
    for (const [slug, agent] of agentMap.entries()) {
        const candidate = normalizeCandidate(agent, slug);
        if (candidate) {
            candidates.push(candidate);
        }
    }

    return dedupeCandidates(candidates);
}

function isShortHexId(value: string): boolean {
    return (
        /^[0-9a-fA-F]+$/.test(value)
        && value.length >= PUBKEY_DISPLAY_LENGTH
        && value.length <= STORAGE_PREFIX_LENGTH
    );
}

function findByPubkey(candidates: AgentIdCandidate[], pubkey: string): AgentIdCandidate | null {
    const normalized = pubkey.toLowerCase();
    return candidates.find((agent) => agent.pubkey.toLowerCase() === normalized) ?? null;
}

function tryResolveFromPrefixStore(identifier: string, candidates: AgentIdCandidate[]): AgentIdCandidate | null {
    if (!prefixKVStore.isInitialized()) {
        return null;
    }

    try {
        const resolved = prefixKVStore.lookupUniquePrefix(identifier);
        return resolved ? findByPubkey(candidates, resolved) : null;
    } catch (error) {
        logger.debug("Failed to resolve agent id from prefix store", { identifier, error });
        return null;
    }
}

/**
 * Resolve an agent id to the project agent pubkey it names.
 *
 * Agent slugs are treated as ids, and take priority over pubkey-shaped values
 * if a project deliberately creates a slug with the same text.
 */
export function resolveAgentIdFromCandidates(
    identifier: string,
    candidates: Iterable<AgentIdCandidate>
): AgentResolutionResult {
    const trimmedIdentifier = identifier.trim();
    const identifierLower = trimmedIdentifier.toLowerCase();
    const agents = dedupeCandidates(Array.from(candidates));
    const availableIds = Array.from(new Set(agents.map((agent) => agent.slug)));

    const slugMatch = agents.find((agent) => agent.slug.toLowerCase() === identifierLower);
    if (slugMatch) {
        return {
            pubkey: slugMatch.pubkey,
            slug: slugMatch.slug,
            availableIds,
            availableSlugs: availableIds,
        };
    }

    const exactMatch = findByPubkey(agents, identifierLower);
    if (exactMatch) {
        return {
            pubkey: exactMatch.pubkey,
            slug: exactMatch.slug,
            availableIds,
            availableSlugs: availableIds,
        };
    }

    const parsedPubkey = parseNostrUser(trimmedIdentifier);
    if (parsedPubkey) {
        const parsedMatch = findByPubkey(agents, parsedPubkey);
        if (parsedMatch) {
            return {
                pubkey: parsedMatch.pubkey,
                slug: parsedMatch.slug,
                availableIds,
                availableSlugs: availableIds,
            };
        }
    }

    if (isShortHexId(identifierLower)) {
        const prefixStoreMatch = tryResolveFromPrefixStore(identifierLower, agents);
        if (prefixStoreMatch) {
            return {
                pubkey: prefixStoreMatch.pubkey,
                slug: prefixStoreMatch.slug,
                availableIds,
                availableSlugs: availableIds,
            };
        }

        const prefixMatches = agents.filter((agent) =>
            agent.pubkey.toLowerCase().startsWith(identifierLower)
        );
        if (prefixMatches.length === 1) {
            return {
                pubkey: prefixMatches[0].pubkey,
                slug: prefixMatches[0].slug,
                availableIds,
                availableSlugs: availableIds,
            };
        }
        if (prefixMatches.length > 1) {
            logger.debug("Agent id prefix is ambiguous", {
                identifier: trimmedIdentifier,
                matchCount: prefixMatches.length,
            });
            return {
                pubkey: null,
                slug: null,
                availableIds,
                availableSlugs: availableIds,
                failureReason: "ambiguous",
            };
        }
    }

    logger.debug("Agent id not found", { identifier: trimmedIdentifier, availableIds });
    return {
        pubkey: null,
        slug: null,
        availableIds,
        availableSlugs: availableIds,
        failureReason: "not_found",
    };
}

export function resolveAgentId(identifier: string): AgentResolutionResult {
    try {
        return resolveAgentIdFromCandidates(identifier, getProjectAgentCandidates());
    } catch (error) {
        const trimmedIdentifier = identifier.trim();
        logger.debug("Failed to resolve agent id", { identifier: trimmedIdentifier, error });
        return {
            pubkey: null,
            slug: null,
            availableIds: [],
            availableSlugs: [],
            failureReason: "not_found",
        };
    }
}
