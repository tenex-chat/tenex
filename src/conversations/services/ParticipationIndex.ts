import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Service for tracking agent participations in conversations
 * Single Responsibility: Index and query agent participation history
 */
export class ParticipationIndex {
    // conversationId -> agentPubkey -> Set of eventIds
    private index = new Map<string, Map<string, Set<string>>>();

    /**
     * Build or update index from conversation history
     */
    buildIndex(conversationId: string, history: NDKEvent[]): void {
        if (!this.index.has(conversationId)) {
            this.index.set(conversationId, new Map());
        }

        const convIndex = this.index.get(conversationId);
        if (!convIndex) return;

        // Clear and rebuild to ensure consistency
        convIndex.clear();

        for (const event of history) {
            // Skip events without pubkey (shouldn't happen but be safe)
            if (!event.pubkey) continue;

            if (!convIndex.has(event.pubkey)) {
                convIndex.set(event.pubkey, new Set());
            }

            const eventSet = convIndex.get(event.pubkey);
            if (eventSet) {
                eventSet.add(event.id);
            }
        }

        logger.debug("[ParticipationIndex] Built index", {
            conversationId: conversationId.substring(0, 8),
            participantCount: convIndex.size,
            totalEvents: history.length,
        });
    }

    /**
     * Get all event IDs where an agent participated
     */
    getAgentParticipations(conversationId: string, agentPubkey: string): string[] {
        const convIndex = this.index.get(conversationId);
        if (!convIndex) {
            logger.debug("[ParticipationIndex] No index for conversation", {
                conversationId: conversationId.substring(0, 8),
            });
            return [];
        }

        const participations = convIndex.get(agentPubkey);
        if (!participations) {
            logger.debug("[ParticipationIndex] Agent has no participations", {
                conversationId: conversationId.substring(0, 8),
                agentPubkey: agentPubkey.substring(0, 8),
            });
            return [];
        }

        return Array.from(participations);
    }

    /**
     * Check if an agent has participated in a conversation
     */
    hasAgentParticipated(conversationId: string, agentPubkey: string): boolean {
        const convIndex = this.index.get(conversationId);
        if (!convIndex) return false;

        const participations = convIndex.get(agentPubkey);
        return participations ? participations.size > 0 : false;
    }

    /**
     * Get all agents who have participated in a conversation
     */
    getParticipants(conversationId: string): string[] {
        const convIndex = this.index.get(conversationId);
        if (!convIndex) return [];

        return Array.from(convIndex.keys());
    }

    /**
     * Get participation count for an agent
     */
    getParticipationCount(conversationId: string, agentPubkey: string): number {
        const convIndex = this.index.get(conversationId);
        if (!convIndex) return 0;

        const participations = convIndex.get(agentPubkey);
        return participations ? participations.size : 0;
    }

    /**
     * Clear index for a conversation (for cleanup)
     */
    clearConversation(conversationId: string): void {
        this.index.delete(conversationId);
        logger.debug("[ParticipationIndex] Cleared index for conversation", {
            conversationId: conversationId.substring(0, 8),
        });
    }

    /**
     * Get all unique threads an agent has participated in
     * Returns root event IDs of threads
     */
    getAgentThreadRoots(
        conversationId: string,
        agentPubkey: string,
        history: NDKEvent[],
        threadService: { getThreadToEvent: (id: string, history: NDKEvent[]) => NDKEvent[] }
    ): string[] {
        const participations = this.getAgentParticipations(conversationId, agentPubkey);
        const threadRoots = new Set<string>();

        for (const eventId of participations) {
            const thread = threadService.getThreadToEvent(eventId, history);
            if (thread.length > 0) {
                threadRoots.add(thread[0].id);
            }
        }

        return Array.from(threadRoots);
    }
}
