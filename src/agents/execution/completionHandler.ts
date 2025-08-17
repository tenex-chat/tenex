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
    const { response, summary, publisher, agent, conversationId: _conversationId, conversationManager: _conversationManager, triggeringEvent } = options;

    const projectContext = getProjectContext();
    const { logger } = await import("@/utils/logger");
    
    // Check if this is completing a sub-task (NDKTask kind 1934)
    const isTaskCompletion = triggeringEvent?.kind === 1934;
    
    if (isTaskCompletion) {
        // This is a sub-task completion - respond to the task delegator
        const delegatorPubkey = triggeringEvent.pubkey;
        
        logger.info("[handleAgentCompletion] Completing NDKTask", {
            taskId: triggeringEvent.id,
            agent: agent.name,
            delegator: delegatorPubkey,
        });
        
        // Build completion reply to the task
        const reply = publisher.createBaseReply();
        reply.content = response;
        reply.tag(["e", triggeringEvent.id, "", "reply"]);  // Reply to the task
        reply.tag(["p", delegatorPubkey]);  // Notify the delegator
        reply.tag(["status", "complete"]);
        reply.tag(["tool", "complete"]);
        
        if (summary) {
            reply.tag(["summary", summary]);
        }
        
        // Return task completion
        return {
            completion: {
                type: "complete",
                completion: {
                    response,
                    summary: summary || response,
                    nextAgent: delegatorPubkey,
                },
            },
            event: reply
        };
    } else {
        // Regular conversation completion - respond to PM/orchestrator
        const orchestratorAgent = projectContext.getProjectAgent();
        const respondToPubkey = orchestratorAgent.pubkey;

        // No turn tracking needed - PM infers from conversation history

        // Build the event but don't publish
        const reply = publisher.createBaseReply();
        reply.content = response;
        reply.tag(["p", respondToPubkey]);
        reply.tag(["tool", "complete"]);
        
        // Add summary tag if provided
        if (summary) {
            reply.tag(["summary", summary]);
        }
        
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
}
