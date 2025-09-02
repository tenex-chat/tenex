import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { parseNostrUser } from "@/utils/nostr-entity-parser";

/**
 * Resolve a recipient string to a pubkey
 * @param recipient - Agent slug, name, npub, or hex pubkey
 * @returns Pubkey hex string or null if not found
 */
export function resolveRecipientToPubkey(recipient: string): string | null {
  // Trim whitespace
  recipient = recipient.trim();

  // Try to parse as a Nostr user identifier (npub, nprofile, hex, with/without nostr: prefix)
  const parsedPubkey = parseNostrUser(recipient);
  if (parsedPubkey) {
    return parsedPubkey;
  }

  // Try to resolve as agent slug or name (case-insensitive)
  try {
    const projectContext = getProjectContext();

    // Check project agents with case-insensitive matching for both slug and name
    const recipientLower = recipient.toLowerCase();
    for (const [slug, agent] of projectContext.agents.entries()) {
      if (slug.toLowerCase() === recipientLower || agent.name.toLowerCase() === recipientLower) {
        return agent.pubkey;
      }
    }

    logger.debug("Agent slug or name not found", { recipient });
    return null;
  } catch (error) {
    logger.debug("Failed to resolve agent slug or name", { recipient, error });
    return null;
  }
}
