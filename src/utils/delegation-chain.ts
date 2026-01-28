/**
 * Delegation Chain Utilities
 *
 * This module provides utilities for tracking and displaying the delegation chain
 * in multi-agent workflows. The delegation chain shows agents their position in
 * the hierarchy, helping them understand context and prevent circular delegations.
 *
 * Example chain:
 * [User -> architect-orchestrator] [conversation 4f69d3302cf2]
 *   -> [architect-orchestrator -> execution-coordinator] [conversation 8a2bc1e45678]
 *     -> [execution-coordinator -> claude-code (you)] [conversation 1234567890ab]
 *
 * SEMANTIC MODEL (Option B - Store on Recipient):
 * Each entry's `conversationId` represents "the conversation where this agent was
 * DELEGATED TO" (i.e., where they received the delegation from their delegator).
 *
 * Example with conversations:
 *   User (in user-conv) delegates to pm-wip
 *   pm-wip (in pm-conv) delegates to exec
 *   exec (in exec-conv) delegates to claude-code
 *
 * Chain entries:
 *   - User: conversationId = undefined (origin, wasn't delegated)
 *   - pm-wip: conversationId = user-conv (was delegated to in user-conv)
 *   - exec: conversationId = pm-conv (was delegated to in pm-conv)
 *   - claude-code: conversationId = exec-conv (was delegated to in exec-conv)
 *
 * When displaying [A -> B] [conversation X], X = B.conversationId
 * (the conversation where B was delegated to, i.e., where A delegated to B)
 */

import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { DelegationChainEntry } from "@/conversations/types";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { getPubkeyService } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";

/**
 * Truncate a conversation ID to PREFIX_LENGTH hex characters for display.
 */
export function truncateConversationId(conversationId: string): string {
    return conversationId.substring(0, PREFIX_LENGTH);
}

/**
 * Build a delegation chain from a triggering event.
 *
 * The chain is built by:
 * 1. Looking for the "delegation" tag in the event (points to parent conversation)
 * 2. Recursively following parent conversations to build the full chain
 * 3. Including the sender as the immediate delegator
 *
 * SEMANTICS: Each entry's `conversationId` represents "the conversation where this agent
 * was DELEGATED TO". When displaying [A -> B] [conversation X], X comes from B.conversationId.
 * - Origin agent has no conversationId (they started the chain, weren't delegated)
 * - Current agent's conversationId = parentConversationId (where they were delegated to)
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
     * Returns the agent slug if known, or the user's name from their Nostr profile if it's the project owner.
     * Uses PubkeyService.getNameSync() which returns cached profile name or shortened pubkey as fallback.
     */
    const resolveDisplayName = (pubkey: string): { displayName: string; isUser: boolean } => {
        if (pubkey === projectOwnerPubkey) {
            // Use PubkeyService to get the user's display name from their Nostr profile
            const displayName = getPubkeyService().getNameSync(pubkey);
            return { displayName, isUser: true };
        }

        if (projectContext) {
            const agent = projectContext.getAgentByPubkey(pubkey);
            if (agent) {
                return { displayName: agent.slug, isUser: false };
            }
        }

        // Unknown pubkey - use truncated version
        return { displayName: pubkey.substring(0, PREFIX_LENGTH), isUser: false };
    };

    // Build the chain by walking up through parent conversations
    //
    // ALGORITHM: We walk from child to parent conversations, tracking where each
    // agent was "delegated TO". When we visit conversation C:
    // - The initiator of C was delegated TO in the conversation that led us TO C
    //   (i.e., the conversation we came from, which had a delegation tag pointing to C)
    //
    // Example: claude-code <- exec-conv <- pm-conv <- user-conv
    // - claude was delegated TO in exec-conv (parentConversationId)
    // - We visit exec-conv, find initiator=exec. exec was delegated TO in pm-conv
    //   (the conv that pointed to exec-conv)
    // - We visit pm-conv, find initiator=pm. pm was delegated TO in user-conv
    // - We visit user-conv, find initiator=User. User is origin (no conversationId)

    let currentParentId: string | undefined = parentConversationId;
    const visitedConversations = new Set<string>();
    const seenPubkeys = new Set<string>();

    // Collect ancestors as we walk up (newest -> oldest)
    interface CollectedEntry {
        pubkey: string;
        displayName: string;
        isUser: boolean;
        delegatedToInConvId?: string; // The conversation where this agent received delegation
    }
    const collectedAncestors: CollectedEntry[] = [];

    // Track where the immediate delegator (event.pubkey) was delegated TO
    // This will be discovered as we walk up
    let immediateDelegatorConvId: string | undefined;

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
            // The stored chain is authoritative - use it
            // Clear any collectedAncestors that overlap with the stored chain
            const storedPubkeys = new Set(parentChain.map(e => e.pubkey));
            for (let i = collectedAncestors.length - 1; i >= 0; i--) {
                if (storedPubkeys.has(collectedAncestors[i].pubkey)) {
                    seenPubkeys.delete(collectedAncestors[i].pubkey);
                    collectedAncestors.splice(i, 1);
                }
            }

            // Use the parent's already-computed chain (it's already in oldest-first order)
            // Clone entries to avoid mutating stored chain
            for (const entry of parentChain) {
                if (!seenPubkeys.has(entry.pubkey)) {
                    seenPubkeys.add(entry.pubkey);
                    chain.push({ ...entry });
                }
            }

            // The immediate delegator (event.pubkey) was delegated TO in currentParentId
            // (this is the conversation where the stored chain ends, where they work)
            immediateDelegatorConvId = currentParentId;

            // We have the full ancestry from the stored chain - stop walking
            break;
        }

        // Get the first message to find who initiated this conversation
        const messages = parentStore.getAllMessages();
        if (messages.length === 0) {
            break;
        }

        const firstMessage = messages[0];

        // Try to find if this parent conversation itself was a delegation
        // This tells us where the initiator of THIS conversation was delegated TO
        const rootEventId = parentStore.getRootEventId();
        let nextParentId: string | undefined;
        if (rootEventId) {
            const rootEvent = ConversationStore.getCachedEvent(rootEventId);
            if (rootEvent) {
                const parentDelegationTag = rootEvent.tags.find(t => t[0] === "delegation");
                if (parentDelegationTag && parentDelegationTag[1]) {
                    nextParentId = parentDelegationTag[1];
                }
            }
        }

        // Add this conversation's initiator to our collected ancestors (if not seen)
        // The initiator was delegated TO in nextParentId (the conv that led to this one)
        // If nextParentId is undefined, this is the origin (wasn't delegated)
        if (!seenPubkeys.has(firstMessage.pubkey)) {
            seenPubkeys.add(firstMessage.pubkey);
            const { displayName, isUser } = resolveDisplayName(firstMessage.pubkey);
            collectedAncestors.push({
                pubkey: firstMessage.pubkey,
                displayName,
                isUser,
                delegatedToInConvId: nextParentId, // Where this agent was delegated TO (or undefined for origin)
            });
        }

        // If the initiator is the immediate delegator, record where they were delegated TO
        if (firstMessage.pubkey === event.pubkey && immediateDelegatorConvId === undefined) {
            immediateDelegatorConvId = nextParentId;
        }

        if (nextParentId) {
            // Continue walking up
            currentParentId = nextParentId;
        } else {
            // No further delegation found - we've reached the origin
            break;
        }
    }

    // Reverse collected ancestors to get oldest-first order (origin first)
    collectedAncestors.reverse();

    // Convert collectedAncestors to chain entries
    // SEMANTICS: entry.conversationId = "where this agent was delegated TO"
    // Store FULL conversation IDs - truncation happens at display time in formatDelegationChain
    for (const ancestor of collectedAncestors) {
        if (!chain.some(e => e.pubkey === ancestor.pubkey)) {
            chain.push({
                pubkey: ancestor.pubkey,
                displayName: ancestor.displayName,
                isUser: ancestor.isUser,
                conversationId: ancestor.delegatedToInConvId, // Store full ID
            });
        }
    }

    // Add the immediate delegator (event.pubkey) if not already in chain.
    // If chain is empty, delegator is the origin (no conversationId)
    // Otherwise, delegator was delegated TO in immediateDelegatorConvId (or parentConversationId for legacy)
    if (!seenPubkeys.has(event.pubkey) && !chain.some(e => e.pubkey === event.pubkey)) {
        const { displayName, isUser } = resolveDisplayName(event.pubkey);
        seenPubkeys.add(event.pubkey);

        // If chain is empty, this delegator is the origin (no conversationId)
        // Otherwise, their conversationId = where they were delegated TO
        // Use immediateDelegatorConvId if set (from stored chain), or parentConversationId (legacy path)
        // Store FULL conversation ID - truncation happens at display time
        const isOrigin = chain.length === 0;
        const delegatorConvId = isOrigin ? undefined : (immediateDelegatorConvId || parentConversationId);
        chain.push({
            pubkey: event.pubkey,
            displayName,
            isUser,
            conversationId: delegatorConvId, // Store full ID
        });
    }

    // Add the current agent at the end (if not already in chain)
    // Current agent was delegated TO in parentConversationId
    // Store FULL conversation ID - truncation happens at display time
    if (!seenPubkeys.has(currentAgentPubkey) && !chain.some(e => e.pubkey === currentAgentPubkey)) {
        const currentAgentInfo = resolveDisplayName(currentAgentPubkey);
        chain.push({
            pubkey: currentAgentPubkey,
            displayName: currentAgentInfo.displayName,
            isUser: false,
            conversationId: parentConversationId, // Store full ID
        });
    }

    logger.debug("[delegation-chain] Built delegation chain", {
        chainLength: chain.length,
        chain: chain.map(c => `${c.displayName}(${c.conversationId || "origin"})`).join(" → "),
    });

    return chain;
}

/**
 * Format a delegation chain as a multi-line tree showing delegation relationships.
 *
 * Each line shows: [sender -> recipient] [conversation <id>]
 * With indentation showing the delegation depth.
 *
 * SEMANTICS: The conversation ID shown for [A -> B] comes from B.conversationId
 * (the conversation where B was delegated to, i.e., where A delegated to B).
 * This is consistent for ALL links, including the final link.
 *
 * @param chain - The delegation chain entries (each entry has full conversation ID stored)
 * @param currentAgentPubkey - The pubkey of the current agent (to mark with "(you)")
 * @returns A formatted multi-line string showing the delegation tree
 *
 * Example output:
 * ```
 * [User -> architect-orchestrator] [conversation 4f69d3302cf2]
 *   -> [architect-orchestrator -> execution-coordinator] [conversation 8a2bc1e45678]
 *     -> [execution-coordinator -> claude-code (you)] [conversation 1234567890ab]
 * ```
 */
export function formatDelegationChain(
    chain: DelegationChainEntry[],
    currentAgentPubkey: string
): string {
    if (chain.length === 0) {
        return "";
    }

    if (chain.length === 1) {
        // Single entry - just show the agent with (you) marker if applicable
        const entry = chain[0];
        const suffix = entry.pubkey === currentAgentPubkey ? " (you)" : "";
        return `${entry.displayName}${suffix}`;
    }

    const lines: string[] = [];

    // Build delegation links: each link is from entry[i] -> entry[i+1]
    // SEMANTICS: recipient.conversationId = "where recipient was delegated TO"
    // So for [A -> B], we use B.conversationId (recipient.conversationId)
    for (let i = 0; i < chain.length - 1; i++) {
        const sender = chain[i];
        const recipient = chain[i + 1];

        // Add (you) marker if recipient is current agent
        const recipientSuffix = recipient.pubkey === currentAgentPubkey ? " (you)" : "";
        const recipientName = `${recipient.displayName}${recipientSuffix}`;

        // Get the conversation ID for this link from RECIPIENT.conversationId
        // Truncate to PREFIX_LENGTH chars for display (full IDs are stored in chain entries)
        const convId = recipient.conversationId
            ? truncateConversationId(recipient.conversationId)
            : "unknown";

        // Build the line with proper indentation
        const indent = i === 0 ? "" : "  ".repeat(i) + "-> ";
        const line = `${indent}[${sender.displayName} -> ${recipientName}] [conversation ${convId}]`;
        lines.push(line);
    }

    return lines.join("\n");
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
