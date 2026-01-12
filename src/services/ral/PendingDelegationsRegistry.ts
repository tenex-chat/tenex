/**
 * PendingDelegationsRegistry - Tracks delegation event IDs for q-tag correlation
 *
 * This registry stores delegation event IDs at creation time (in AgentPublisher)
 * and retrieves them at tool completion time (in ToolExecutionTracker).
 *
 * This solves the problem of MCP result transformation stripping delegation info:
 * - Registration happens at the source (AgentPublisher.ask/delegate) before any transformation
 * - Consumption happens in ToolExecutionTracker.completeExecution
 * - Works identically for both MCP and non-MCP code paths
 *
 * Key: (agentPubkey, conversationId)
 * Value: Array of delegation event IDs (accumulated, consumed as batch)
 */

import { logger } from "@/utils/logger";

type RegistryKey = `${string}:${string}`; // agentPubkey:conversationId

class PendingDelegationsRegistryImpl {
    private delegations = new Map<RegistryKey, string[]>();

    private makeKey(agentPubkey: string, conversationId: string): RegistryKey {
        return `${agentPubkey}:${conversationId}`;
    }

    /**
     * Register a delegation event ID.
     * Called by AgentPublisher when creating ask/delegate events.
     *
     * @param agentPubkey - The agent's pubkey
     * @param conversationId - The conversation ID (root event ID)
     * @param delegationEventId - The ID of the created delegation event
     */
    register(agentPubkey: string, conversationId: string, delegationEventId: string): void {
        const key = this.makeKey(agentPubkey, conversationId);
        const existing = this.delegations.get(key) || [];
        existing.push(delegationEventId);
        this.delegations.set(key, existing);

        logger.debug("[PendingDelegationsRegistry] Registered delegation", {
            agentPubkey: agentPubkey.substring(0, 8),
            conversationId: conversationId.substring(0, 8),
            delegationEventId: delegationEventId.substring(0, 8),
            totalPending: existing.length,
        });
    }

    /**
     * Consume (retrieve and clear) all pending delegation event IDs.
     * Called by ToolExecutionTracker when completing a delegation tool.
     *
     * @param agentPubkey - The agent's pubkey
     * @param conversationId - The conversation ID (root event ID)
     * @returns Array of delegation event IDs, empty if none registered
     */
    consume(agentPubkey: string, conversationId: string): string[] {
        const key = this.makeKey(agentPubkey, conversationId);
        const delegations = this.delegations.get(key) || [];
        this.delegations.delete(key);

        if (delegations.length > 0) {
            logger.debug("[PendingDelegationsRegistry] Consumed delegations", {
                agentPubkey: agentPubkey.substring(0, 8),
                conversationId: conversationId.substring(0, 8),
                count: delegations.length,
                eventIds: delegations.map((id) => id.substring(0, 8)),
            });
        }

        return delegations;
    }

    /**
     * Peek at pending delegations without consuming them.
     * Useful for debugging and testing.
     */
    peek(agentPubkey: string, conversationId: string): string[] {
        const key = this.makeKey(agentPubkey, conversationId);
        return [...(this.delegations.get(key) || [])];
    }

    /**
     * Clear all pending delegations.
     * Useful for testing cleanup.
     */
    clear(): void {
        this.delegations.clear();
    }

    /**
     * Get the number of conversations with pending delegations.
     * Useful for debugging.
     */
    get size(): number {
        return this.delegations.size;
    }
}

// Export singleton instance
export const PendingDelegationsRegistry = new PendingDelegationsRegistryImpl();
