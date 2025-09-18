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
    event?: NDKEvent; // The actual response event for threading
  }>;
}

/**
 * Service that handles delegation execution.
 * Orchestrates the complete delegation workflow: publishing events and waiting for responses.
 */
export class DelegationService {
  constructor(
    private agent: AgentInstance,
    private conversationId: string,
    private conversationCoordinator: ConversationCoordinator,
    private triggeringEvent: NDKEvent,
    private publisher: AgentPublisher,
  ) {}

  /**
   * Execute a delegation and wait for all responses.
   */
  async execute(intent: DelegationIntent & { suggestions?: string[] }): Promise<DelegationResponses> {
    // Check for self-delegation attempts
    const selfDelegationAttempts = intent.recipients.filter(
      pubkey => pubkey === this.agent.pubkey
    );
    
    // Only allow self-delegation when phase is explicitly provided (i.e., delegate_phase tool)
    if (selfDelegationAttempts.length > 0) {
      if (!intent.phase) {
        throw new Error(
          `Self-delegation is not permitted. Agent "${this.agent.slug}" cannot delegate to itself. ` +
          `Self-delegation is only allowed when using the delegate_phase tool for phase transitions.`
        );
      }
      
      logger.info("[DelegationService] 🔄 Agent delegating to itself via phase transition", {
        fromAgent: this.agent.slug,
        agentPubkey: this.agent.pubkey,
        phase: intent.phase,
        request: intent.request,
      });
    }

    // Build event context
    const conversation = this.conversationCoordinator.getConversation(this.conversationId);
    const eventContext = {
      triggeringEvent: this.triggeringEvent,
      rootEvent: conversation?.history[0] ?? this.triggeringEvent, // Use triggering event as fallback
      conversationId: this.conversationId,
    };

    // Publish based on intent type
    let result: { batchId: string };
    
    if (intent.type === "ask") {
      // Handle ask intent
      const askResult = await this.publisher.ask({
        content: intent.request,
        suggestions: intent.suggestions,
      }, eventContext);
      result = { batchId: askResult.batchId };
    } else if (intent.type === "delegation_followup") {
      result = await this.publisher.delegateFollowUp(intent, eventContext);
    } else {
      result = await this.publisher.delegate(intent, eventContext);
    }

    // Wait for all responses
    const registry = DelegationRegistry.getInstance();
    
    // Wait for all responses - no timeout as delegations are long-running
    const completions = await registry.waitForBatchCompletion(result.batchId);
    
    // Return formatted responses with event details
    return {
      type: "delegation_responses",
      responses: completions.map(c => ({
        response: c.response,
        summary: c.summary,
        from: c.assignedTo,
        event: c.event,
      })),
    };
  }
}