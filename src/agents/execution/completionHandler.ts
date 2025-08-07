import { getProjectContext } from "@/services/ProjectContext";
import type { Complete } from "@/tools/types";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import type { Agent } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Shared completion logic used by both the complete() tool and ClaudeBackend
 * Ensures consistent behavior when agents complete their tasks
 */

export interface CompletionOptions {
    response: string;
    summary?: string;
    agent: Agent;
    conversationId: string;
    publisher: NostrPublisher;
    triggeringEvent?: NDKEvent;
}

/**
 * Handle agent task completion by publishing to orchestrator and logging
 * This is the core logic extracted from the complete() tool
 */
export async function handleAgentCompletion(options: CompletionOptions): Promise<Complete> {
    const { response, summary, publisher } = options;

    const projectContext = getProjectContext();
    const orchestratorAgent = projectContext.getProjectAgent();

    // Always route completions to the orchestrator for phase control
    const respondToPubkey = orchestratorAgent.pubkey;

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
