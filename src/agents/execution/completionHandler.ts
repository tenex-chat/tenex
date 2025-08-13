import { getProjectContext } from "@/services/ProjectContext";
import type { Complete } from "@/tools/types";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import type { AgentInstance } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ConversationManager } from "@/conversations/ConversationManager";

/**
 * Shared completion logic used by both the complete() tool and ClaudeBackend
 * Ensures consistent behavior when agents complete their tasks
 */

export interface CompletionOptions {
    response: string;
    summary?: string;
    agent: AgentInstance;
    conversationId: string;
    publisher: NostrPublisher;
    triggeringEvent?: NDKEvent;
    conversationManager?: ConversationManager;
}

/**
 * Handle agent task completion by publishing to whoever invoked this agent
 * This is the core logic extracted from the complete() tool
 */
export async function handleAgentCompletion(options: CompletionOptions): Promise<Complete> {
    const { response, summary, publisher, agent, conversationId, conversationManager, triggeringEvent } = options;

    const projectContext = getProjectContext();
    const orchestratorAgent = projectContext.getProjectAgent();

    // Respond to whoever p-tagged us (if available), otherwise to orchestrator
    let respondToPubkey = orchestratorAgent.pubkey;
    
    // Check if triggering event has p-tags to determine who invoked us
    if (triggeringEvent?.tags) {
        const pTags = triggeringEvent.tags.filter(tag => tag[0] === "p");
        // Find the first p-tag that matches our pubkey (we were p-tagged)
        // The sender is who we should respond to
        if (pTags.some(tag => tag[1] === agent.pubkey)) {
            // We were p-tagged, respond to the sender
            respondToPubkey = triggeringEvent.pubkey;
        }
    }

    // Track completion in orchestrator turn if conversation manager available
    if (conversationManager) {
        await conversationManager.addCompletionToTurn(
            conversationId,
            agent.slug,
            summary || response
        );
    }

    // Publish the completion event
    await publisher.publishResponse({
        content: response,
        destinationPubkeys: [respondToPubkey],
        additionalTags: [
            [ "tool", "complete" ]
        ],
        completeMetadata: {
            type: "complete",
            completion: {
                response,
                summary: summary || response,
                nextAgent: respondToPubkey,
            },
        },
    });
    
    // Return the Complete termination
    return {
        type: "complete",
        completion: {
            response,
            summary: summary || response,
            nextAgent: respondToPubkey,
        },
    };
}
