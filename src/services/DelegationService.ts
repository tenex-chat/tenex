import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { DelegationIntent } from "@/nostr/AgentEventEncoder";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface DelegationResponses {
  type: "delegation_responses";
  responses: Array<{
    response: string;
    summary?: string;
    from: string;
  }>;
}

/**
 * Service that handles delegation execution.
 * Orchestrates the complete delegation workflow: publishing events and waiting for responses.
 */
export class DelegationService {
  private publisher: AgentPublisher;

  constructor(
    private agent: AgentInstance,
    private conversationId: string,
    private conversationCoordinator: ConversationCoordinator,
    private triggeringEvent: NDKEvent,
    private phase?: string
  ) {
    this.publisher = new AgentPublisher(agent, conversationCoordinator);
  }

  /**
   * Execute a delegation and wait for all responses.
   */
  async execute(intent: DelegationIntent): Promise<DelegationResponses> {
    // Build event context
    const conversation = this.conversationCoordinator.getConversation(this.conversationId);
    const eventContext = {
      triggeringEvent: this.triggeringEvent,
      rootEvent: conversation?.history[0], // Root event is first in history
      conversationId: this.conversationId,
      phase: this.phase,
    };

    // Publish delegation events
    const result = await this.publisher.delegate(intent, eventContext);
    
    logger.info("[DelegationService] 🔄 SYNCHRONOUS MODE: Waiting for delegation responses", {
      batchId: result.batchId,
      eventCount: result.events.length,
      fromAgent: this.agent.slug,
      recipientCount: intent.recipients.length,
    });

    // Wait for all responses
    const registry = DelegationRegistry.getInstance();
    
    try {
      const completions = await registry.waitForBatchCompletion(result.batchId);
      
      logger.info("[DelegationService] ✅ SYNCHRONOUS MODE: All responses received", {
        batchId: result.batchId,
        responseCount: completions.length,
        mode: "synchronous",
      });
      
      // Return formatted responses
      return {
        type: "delegation_responses",
        responses: completions.map(c => ({
          response: c.response,
          summary: c.summary,
          from: c.assignedTo,
        })),
      };
    } catch (error) {
      // Timeout or other error - try to return partial results
      logger.warn("[DelegationService] ⏱️ TIMEOUT: Delegation timed out, checking for partial responses", {
        batchId: result.batchId,
        error: error instanceof Error ? error.message : String(error),
        mode: "timeout",
      });
      
      // Get partial completions if any
      const partialCompletions = registry.getBatchCompletions(result.batchId);
      
      if (partialCompletions.length > 0) {
        logger.info("[DelegationService] ⚠️ PARTIAL: Returning partial responses after timeout", {
          batchId: result.batchId,
          partialCount: partialCompletions.length,
          mode: "partial",
        });
        
        return {
          type: "delegation_responses",
          responses: partialCompletions.map(c => ({
            response: c.response,
            summary: c.summary,
            from: c.assignedTo,
          })),
        };
      }
      
      // No responses at all - throw the error
      throw error;
    }
  }
}