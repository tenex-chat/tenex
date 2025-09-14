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
  async execute(intent: DelegationIntent): Promise<DelegationResponses> {
    // Check for self-delegation
    const selfDelegationAttempts = intent.recipients.filter(
      pubkey => pubkey === this.agent.pubkey
    );
    
    if (selfDelegationAttempts.length > 0) {
      logger.warn("[DelegationService] ❌ Agent attempted to delegate to itself", {
        fromAgent: this.agent.slug,
        agentPubkey: this.agent.pubkey,
        attemptedRecipients: intent.recipients,
      });
      
      throw new Error("Cannot delegate to yourself. Consider handling this task directly or choosing a different agent to delegate to.");
    }

    // Build event context
    const conversation = this.conversationCoordinator.getConversation(this.conversationId);
    const eventContext = {
      triggeringEvent: this.triggeringEvent,
      rootEvent: conversation?.history[0] ?? this.triggeringEvent, // Use triggering event as fallback
      conversationId: this.conversationId,
    };

    // Publish based on intent type
    const result = intent.type === "delegation_followup"
      ? await this.publisher.delegateFollowUp(intent, eventContext)
      : await this.publisher.delegate(intent, eventContext);

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