import type { AgentInstance } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ConversationCoordinator } from "@/conversations/ConversationCoordinator";
import { NostrPublisher } from "./NostrPublisher";

/**
 * Factory function to create a NostrPublisher with consistent configuration
 */
export async function createNostrPublisher(params: {
    conversationId: string;
    agent: AgentInstance;
    triggeringEvent: NDKEvent;
    conversationManager: ConversationCoordinator;
}): Promise<NostrPublisher> {
    const { NostrPublisher: Publisher } = await import("@/nostr/NostrPublisher");
    return new Publisher({
        conversationId: params.conversationId,
        agent: params.agent,
        triggeringEvent: params.triggeringEvent,
        conversationManager: params.conversationManager,
    });
}