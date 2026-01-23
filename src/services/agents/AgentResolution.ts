import { getProjectContext } from "@/services/projects";
import { prefixKVStore } from "@/services/storage";
import { logger } from "@/utils/logger";
import { isHexPrefix, parseNostrUser } from "@/utils/nostr-entity-parser";

/**
 * Resolve a recipient string to a pubkey
 *
 * Resolution order (important for correct behavior):
 * 1. Exact Nostr identifiers (npub, nprofile, 64-char hex pubkey)
 * 2. Agent slug or name (case-insensitive) - checked BEFORE prefix to avoid shadowing
 * 3. 12-char hex prefix lookup (only if it resolves to a known agent pubkey)
 *
 * @param recipient - Agent slug, name, npub, hex pubkey, or 12-char hex prefix
 * @returns Pubkey hex string or null if not found
 */
export function resolveRecipientToPubkey(recipient: string): string | null {
    // Trim whitespace
    recipient = recipient.trim();

    // 1. Try to parse as a Nostr user identifier (npub, nprofile, hex, with/without nostr: prefix)
    const parsedPubkey = parseNostrUser(recipient);
    if (parsedPubkey) {
        return parsedPubkey;
    }

    // 2. Try to resolve as agent slug or name FIRST (before prefix lookup)
    // This prevents 12-char hex slugs from being shadowed by prefix matches
    let agentPubkeys: Set<string> | null = null;
    try {
        const projectContext = getProjectContext();
        const recipientLower = recipient.toLowerCase();
        const agents = projectContext.agentRegistry.getAllAgentsMap();

        // Build set of known agent pubkeys for later validation
        agentPubkeys = new Set<string>();

        for (const [slug, agent] of agents.entries()) {
            agentPubkeys.add(agent.pubkey);
            if (
                slug.toLowerCase() === recipientLower ||
                agent.name.toLowerCase() === recipientLower
            ) {
                return agent.pubkey;
            }
        }
    } catch (error) {
        logger.debug("Failed to resolve agent slug or name", { recipient, error });
        // Continue to prefix lookup as fallback
    }

    // 3. Try to resolve 12-char hex prefix to full pubkey (only if it's an agent pubkey)
    if (isHexPrefix(recipient)) {
        const resolvedFromPrefix = resolveAgentPubkeyFromPrefix(recipient, agentPubkeys);
        if (resolvedFromPrefix) {
            return resolvedFromPrefix;
        }
    }

    logger.debug("Recipient not found", { recipient });
    return null;
}

/**
 * Resolves a 12-char hex prefix to an agent pubkey.
 * Only returns the resolved ID if it's a known agent pubkey (prevents returning event IDs).
 *
 * @param prefix - 12-char hex prefix
 * @param knownAgentPubkeys - Set of known agent pubkeys to validate against (REQUIRED)
 * @returns Agent pubkey or null if not found or not an agent
 */
function resolveAgentPubkeyFromPrefix(
    prefix: string,
    knownAgentPubkeys: Set<string> | null
): string | null {
    // CRITICAL: Require agent pubkey set for validation - without it we could return event IDs
    if (!knownAgentPubkeys) {
        logger.debug("[resolveAgentPubkeyFromPrefix] Cannot resolve prefix without agent pubkey set for validation");
        return null;
    }

    const cleaned = prefix.trim().toLowerCase();

    // Validate format
    if (!/^[0-9a-f]{12}$/.test(cleaned)) {
        return null;
    }

    // Check if store is initialized
    if (!prefixKVStore.isInitialized()) {
        logger.debug("[resolveAgentPubkeyFromPrefix] PrefixKVStore not initialized");
        return null;
    }

    // Attempt lookup with error handling (LMDB can throw)
    let resolved: string | null = null;
    try {
        resolved = prefixKVStore.lookup(cleaned);
    } catch (error) {
        logger.debug("[resolveAgentPubkeyFromPrefix] Prefix lookup failed", { prefix: cleaned, error });
        return null;
    }

    if (!resolved) {
        return null;
    }

    // CRITICAL: Verify the resolved ID is actually a known agent pubkey
    // The prefix store indexes both event IDs and pubkeys, so we must validate
    // (knownAgentPubkeys is guaranteed non-null by the guard at the start)
    if (!knownAgentPubkeys.has(resolved)) {
        logger.debug("[resolveAgentPubkeyFromPrefix] Resolved ID is not a known agent pubkey", {
            prefix: cleaned,
            resolved: resolved.substring(0, 12) + "...",
        });
        return null;
    }

    logger.debug("Resolved agent pubkey from 12-char prefix", {
        prefix: cleaned,
        resolved: resolved.substring(0, 12) + "...",
    });
    return resolved;
}
