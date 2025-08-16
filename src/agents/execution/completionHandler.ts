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
 * Handle agent task completion by preparing the event but not publishing it
 * The caller decides when to publish (immediately for ClaudeBackend, after metadata for ReasonActLoop)
 */
export async function handleAgentCompletion(options: CompletionOptions): Promise<{ completion: Complete; event: NDKEvent }> {
    const { response, summary, publisher, agent, conversationId, conversationManager } = options;

    const projectContext = getProjectContext();
    const orchestratorAgent = projectContext.getProjectAgent();

    // Always respond to the orchestrator
    const respondToPubkey = orchestratorAgent.pubkey;

    // Track completion in orchestrator turn using pubkey for consistent identification
    // IMPORTANT: Pass the FULL response to the orchestrator so it can make informed decisions
    // If there's a summary, include both for complete context
    const completionMessage = summary 
        ? `${response}\n\n[Summary: ${summary}]`
        : response;
    
    await conversationManager.addCompletionToTurn(
        conversationId,
        agent.pubkey,
        completionMessage
    );

    // Build the event but don't publish
    const reply = publisher.createBaseReply();
    reply.content = response;
    reply.tag(["p", respondToPubkey]);
    reply.tag(["tool", "complete"]);
    
    // Add summary tag if provided
    if (summary) {
        reply.tag(["summary", summary]);
    }
    
    // Debug logging
    const { logger } = await import("@/utils/logger");
    logger.debug("[handleAgentCompletion] Created unpublished event", {
        agent: agent.name,
        responseLength: response.length,
        hasSummary: !!summary,
        eventId: reply.id,
        tags: reply.tags.map(t => `${t[0]}=${t[1]?.substring(0, 20)}...`),
    });
    
    // Return both completion and unpublished event
    return {
        completion: {
            type: "complete",
            completion: {
                response,
                summary: summary || response,
                nextAgent: respondToPubkey,
            },
        },
        event: reply
    };
}
