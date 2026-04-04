/**
 * PendingDelegationsRegistry - Tracks event references for tag correlation
 *
 * This registry stores event references at creation time (in AgentPublisher/tools)
 * and retrieves them at tool completion time (in ToolExecutionTracker).
 *
 * This solves the problem of MCP result transformation stripping reference info:
 * - Registration happens at the source before any transformation
 * - Consumption happens in ToolExecutionTracker.completeExecution
 * - Works identically for both MCP and non-MCP code paths
 *
 * Supports:
 * - Delegation event IDs (q-tags) - for ask/delegate tools
 *
 * Key: (agentPubkey, conversationId)
 */

import { shortenEventId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";

type RegistryKey = `${string}:${string}`; // agentPubkey:conversationId

interface PendingReferences {
    delegations: string[];
}

class PendingDelegationsRegistryImpl {
    private pending = new Map<RegistryKey, PendingReferences>();

    private makeKey(agentPubkey: string, conversationId: string): RegistryKey {
        return `${agentPubkey}:${conversationId}`;
    }

    private getOrCreate(key: RegistryKey): PendingReferences {
        let refs = this.pending.get(key);
        if (!refs) {
            refs = { delegations: [] };
            this.pending.set(key, refs);
        }
        return refs;
    }

    /**
     * Register a delegation event ID (for q-tags).
     * Called by AgentPublisher when creating ask/delegate events.
     */
    register(agentPubkey: string, conversationId: string, delegationEventId: string): void {
        const key = this.makeKey(agentPubkey, conversationId);
        const refs = this.getOrCreate(key);
        refs.delegations.push(delegationEventId);

        logger.debug("[PendingDelegationsRegistry] Registered delegation", {
            agentPubkey: agentPubkey.substring(0, 8),
            conversationId: conversationId.substring(0, 8),
            delegationEventId: shortenEventId(delegationEventId),
            totalPending: refs.delegations.length,
        });
    }

    /**
     * Consume (retrieve and clear) all pending delegation event IDs.
     * Called by ToolExecutionTracker when completing a delegation tool.
     */
    consume(agentPubkey: string, conversationId: string): string[] {
        const key = this.makeKey(agentPubkey, conversationId);
        const refs = this.pending.get(key);
        if (!refs) return [];

        const delegations = refs.delegations;
        refs.delegations = [];

        this.pending.delete(key);

        if (delegations.length > 0) {
            logger.debug("[PendingDelegationsRegistry] Consumed delegations", {
                agentPubkey: agentPubkey.substring(0, 8),
                conversationId: conversationId.substring(0, 8),
                count: delegations.length,
                eventIds: delegations.map((id) => shortenEventId(id)),
            });
        }

        return delegations;
    }

    /**
     * Peek at pending delegations without consuming them.
     */
    peek(agentPubkey: string, conversationId: string): string[] {
        const key = this.makeKey(agentPubkey, conversationId);
        return [...(this.pending.get(key)?.delegations || [])];
    }

    /**
     * Clear all pending references.
     */
    clear(): void {
        this.pending.clear();
    }

    /**
     * Get the number of conversations with pending references.
     */
    get size(): number {
        return this.pending.size;
    }
}

// Export singleton instance
export const PendingDelegationsRegistry = new PendingDelegationsRegistryImpl();
