/**
 * Delegation Chain Utilities
 *
 * This module provides utilities for tracking and displaying the delegation chain
 * in multi-agent workflows. The delegation chain shows agents their position in
 * the hierarchy, helping them understand context and prevent circular delegations.
 *
 * Example chain: User → pm-wip → execution-coordinator → claude-code (you)
 */

import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { ConversationStore, type DelegationChainEntry } from "@/conversations/ConversationStore";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { logger } from "@/utils/logger";

/**
 * Build a delegation chain from a triggering event.
 *
 * The chain is built by:
 * 1. Looking for the "delegation" tag in the event (points to parent conversation)
 * 2. Recursively following parent conversations to build the full chain
 * 3. Including the sender as the immediate delegator
 *
 * @param event - The event that triggered this conversation
 * @param currentAgentPubkey - The pubkey of the agent receiving the delegation
 * @param projectOwnerPubkey - The pubkey of the project owner (human user)
 * @returns The delegation chain entries, or undefined if this is a direct user message
 */
export function buildDelegationChain(
    event: NDKEvent,
    currentAgentPubkey: string,
    projectOwnerPubkey: string
): DelegationChainEntry[] | undefined {
    // Check for delegation tag - if not present, this is a direct user conversation
    const delegationTag = event.tags.find(t => t[0] === "delegation");
    if (!delegationTag || !delegationTag[1]) {
        // Direct user message - no delegation chain needed
        return undefined;
    }

    const parentConversationId = delegationTag[1];
    const chain: DelegationChainEntry[] = [];

    // Get project context for agent resolution
    let projectContext: ReturnType<typeof getProjectContext> | undefined;
    try {
        if (isProjectContextInitialized()) {
            projectContext = getProjectContext();
        }
    } catch {
        // Project context not available - will use fallback resolution
    }

    /**
     * Helper to resolve a pubkey to a display name.
     * Returns the agent slug if known, or "User" if it's the project owner.
     */
    const resolveDisplayName = (pubkey: string): { displayName: string; isUser: boolean } => {
        if (pubkey === projectOwnerPubkey) {
            return { displayName: "User", isUser: true };
        }

        if (projectContext) {
            const agent = projectContext.getAgentByPubkey(pubkey);
            if (agent) {
                return { displayName: agent.slug, isUser: false };
            }
        }

        // Unknown pubkey - use truncated version
        return { displayName: pubkey.substring(0, 8), isUser: false };
    };

    // Build the chain by walking up through parent conversations
    // Algorithm: Walk backwards from parent to origin, collecting entries,
    // then reverse at the end to get oldest-first ordering.
    let currentParentId: string | undefined = parentConversationId;
    const visitedConversations = new Set<string>();
    const seenPubkeys = new Set<string>();

    // Collect ancestors in reverse order (newest → oldest), we'll reverse at the end
    const collectedAncestors: DelegationChainEntry[] = [];

    while (currentParentId && !visitedConversations.has(currentParentId)) {
        visitedConversations.add(currentParentId);

        const parentStore = ConversationStore.get(currentParentId);
        if (!parentStore) {
            // Parent conversation not found - we've reached the end of our knowledge
            break;
        }

        // Check if this parent conversation has its own delegation chain already computed
        const parentChain = parentStore.metadata.delegationChain;
        if (parentChain && parentChain.length > 0) {
            // Use the parent's already-computed chain (it's already in oldest-first order)
            // Add entries we haven't seen yet to avoid duplicates
            for (const entry of parentChain) {
                if (!seenPubkeys.has(entry.pubkey)) {
                    seenPubkeys.add(entry.pubkey);
                    chain.push(entry);
                }
            }
            // We have the full ancestry from the stored chain - stop walking
            break;
        }

        // Get the first message to find who initiated this conversation
        const messages = parentStore.getAllMessages();
        if (messages.length === 0) {
            break;
        }

        const firstMessage = messages[0];

        // Add this conversation's initiator to our collected ancestors (if not seen)
        if (!seenPubkeys.has(firstMessage.pubkey)) {
            seenPubkeys.add(firstMessage.pubkey);
            const { displayName, isUser } = resolveDisplayName(firstMessage.pubkey);
            collectedAncestors.push({
                pubkey: firstMessage.pubkey,
                displayName,
                isUser,
            });
        }

        // Try to find if this parent conversation itself was a delegation
        // Look for a delegation tag in the cached root event or check root event ID
        const rootEventId = parentStore.getRootEventId();
        if (rootEventId) {
            const rootEvent = ConversationStore.getCachedEvent(rootEventId);
            if (rootEvent) {
                const parentDelegationTag = rootEvent.tags.find(t => t[0] === "delegation");
                if (parentDelegationTag && parentDelegationTag[1]) {
                    // This parent was also delegated - continue walking up
                    currentParentId = parentDelegationTag[1];
                    continue;
                }
            }
        }

        // No further delegation found - this is the origin
        break;
    }

    // Reverse collected ancestors to get oldest-first order and append to chain
    // (chain may already have entries from a stored parent chain)
    collectedAncestors.reverse();
    for (const entry of collectedAncestors) {
        // Double-check for duplicates when merging (belt and suspenders)
        if (!chain.some(e => e.pubkey === entry.pubkey)) {
            chain.push(entry);
        }
    }

    // Always add the immediate delegator (event.pubkey) if not already in chain.
    // This is crucial for legacy conversations where parent exists but has no stored chain.
    // The immediate delegator must appear before the current agent.
    if (!seenPubkeys.has(event.pubkey) && !chain.some(e => e.pubkey === event.pubkey)) {
        const { displayName, isUser } = resolveDisplayName(event.pubkey);
        seenPubkeys.add(event.pubkey);
        chain.push({
            pubkey: event.pubkey,
            displayName,
            isUser,
        });
    }

    // Add the current agent at the end (if not already in chain)
    if (!seenPubkeys.has(currentAgentPubkey) && !chain.some(e => e.pubkey === currentAgentPubkey)) {
        const currentAgentInfo = resolveDisplayName(currentAgentPubkey);
        chain.push({
            pubkey: currentAgentPubkey,
            displayName: currentAgentInfo.displayName,
            isUser: false,
        });
    }

    logger.debug("[delegation-chain] Built delegation chain", {
        chainLength: chain.length,
        chain: chain.map(c => c.displayName).join(" → "),
    });

    return chain;
}

/**
 * Format a delegation chain as a human-readable string.
 *
 * @param chain - The delegation chain entries
 * @param currentAgentPubkey - The pubkey of the current agent (to mark with "(you)")
 * @returns A formatted string like "User → pm-wip → execution-coordinator → claude-code (you)"
 */
export function formatDelegationChain(
    chain: DelegationChainEntry[],
    currentAgentPubkey: string
): string {
    return chain
        .map((entry) => {
            const suffix = entry.pubkey === currentAgentPubkey ? " (you)" : "";
            return `${entry.displayName}${suffix}`;
        })
        .join(" → ");
}

/**
 * Check if adding an agent to the chain would create a circular delegation.
 *
 * @param chain - The current delegation chain
 * @param agentPubkey - The pubkey of the agent to add
 * @returns true if adding this agent would create a cycle
 */
export function wouldCreateCircularDelegation(
    chain: DelegationChainEntry[],
    agentPubkey: string
): boolean {
    return chain.some(entry => entry.pubkey === agentPubkey);
}
