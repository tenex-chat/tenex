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
    conversationManager: ConversationManager;  // Required for orchestrator turn tracking
}

/**
 * Handle agent task completion by always publishing to the orchestrator
 * This is the core logic extracted from the complete() tool
 */
export async function handleAgentCompletion(options: CompletionOptions): Promise<Complete> {
    const { response, summary, publisher, agent, conversationId, conversationManager } = options;

    const projectContext = getProjectContext();
    const orchestratorAgent = projectContext.getProjectAgent();

    // Always respond to the orchestrator
    const respondToPubkey = orchestratorAgent.pubkey;

    // Track completion in orchestrator turn (required for orchestrator to know when to proceed)
    await conversationManager.addCompletionToTurn(
        conversationId,
        agent.slug,
        summary || response
    );

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
