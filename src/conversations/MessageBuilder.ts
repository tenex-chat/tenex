import { getNDK } from "@/nostr";
import { getAgentSlugFromEvent, getTargetedAgentSlugsFromEvent, isEventFromUser } from "@/nostr/utils";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import "@/prompts/fragments/20-phase-constraints";
import "@/prompts/fragments/20-phase-context";
import "@/prompts/fragments/35-specialist-completion-guidance";
import { getProjectContext } from "@/services";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { getPubkeyNameRepository } from "@/services/PubkeyNameRepository";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { CoreMessage } from "ai";
import type { Phase } from "./phases";
import type { Conversation } from "./types";

/**
 * Handles message formatting and processing.
 * Single Responsibility: Transform events and content into properly formatted messages.
 */

// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export  class MessageBuilder {
  private static readonly NOSTR_ENTITY_REGEX = /nostr:(nevent1|naddr1|note1|npub1|nprofile1)\w+/g;

  /**
   * Builds phase-specific instructions to be injected as a system message
   * when an agent transitions to a new phase.
   *
   * This includes:
   * - Current phase context and any transition information
   * - Phase-specific constraints
   * - Phase-specific completion guidance
   */
  static buildPhaseInstructions(phase: Phase, conversation?: Conversation): string {
    const builder = new PromptBuilder()
      .add("phase-context", {
        phase,
        phaseMetadata: conversation?.metadata,
        conversation,
      })
      .add("phase-constraints", {
        phase,
      })
      .add("specialist-completion-guidance", {
        phase,
      });

    return builder.build();
  }

  /**
   * Formats a phase transition message for an agent that is
   * re-entering the conversation in a different phase.
   */
  static formatPhaseTransitionMessage(
    lastSeenPhase: Phase,
    currentPhase: Phase,
    phaseInstructions: string
  ): string {
    return `=== PHASE TRANSITION ===

You were last active in the ${lastSeenPhase.toUpperCase()} phase.
The conversation has now moved to the ${currentPhase.toUpperCase()} phase.

${phaseInstructions}

Please adjust your behavior according to the new phase requirements.`;
  }

  /**
   * Process nostr entities in content, replacing them with inline content
   */
  static async processNostrEntities(content: string): Promise<string> {
    const entities = content.match(MessageBuilder.NOSTR_ENTITY_REGEX);
    if (!entities || entities.length === 0) {
      return content;
    }

    let processedContent = content;
    const ndk = getNDK();

    for (const entity of entities) {
      try {
        const bech32Id = entity.replace("nostr:", "");
        const event = await ndk.fetchEvent(bech32Id);

        if (event) {
          const inlinedContent = `<nostr-event entity="${entity}">${event.content}</nostr-event>`;
          processedContent = processedContent.replace(entity, inlinedContent);

          logger.debug("[MESSAGE_BUILDER] Inlined nostr entity", {
            entity,
            kind: event.kind,
            contentLength: event.content?.length || 0,
          });
        }
      } catch (error) {
        logger.warn("[MESSAGE_BUILDER] Failed to fetch nostr entity", {
          entity,
          error,
        });
        // Keep original entity if fetch fails
      }
    }

    return processedContent;
  }

  /**
   * Format an NDKEvent as a Message for a specific agent
   */
  static async formatEventAsMessage(
    event: NDKEvent,
    processedContent: string,
    targetAgentSlug: string,
    conversationId?: string
  ): Promise<CoreMessage> {
    const eventAgentSlug = getAgentSlugFromEvent(event);
    const nameRepo = getPubkeyNameRepository();
    const projectCtx = getProjectContext();

    // Agent's own message
    if (eventAgentSlug === targetAgentSlug) {
      return { role: "assistant", content: processedContent };
    }

    // Check if this is an external delegation response
    if (conversationId && !isEventFromUser(event)) {
      try {
        const registry = DelegationRegistry.getInstance();
        const targetAgent = projectCtx.getAgent(targetAgentSlug);
        
        if (targetAgent) {
          // Check if there's a delegation record for this conversation
          const delegationContext = registry.getDelegationByConversationKey(
            conversationId,
            targetAgent.pubkey,
            event.pubkey
          );
          
          if (delegationContext && delegationContext.status === "pending") {
            // This is a response to an external delegation
            const responderName = await nameRepo.getName(event.pubkey);
            
            logger.info("[MESSAGE_BUILDER] Formatting external delegation response", {
              conversationId: conversationId.substring(0, 8),
              delegatingAgent: targetAgentSlug,
              respondingAgent: responderName,
              delegationEventId: delegationContext.delegationEventId.substring(0, 8),
            });
            
            // Format as a delegation response with clear context
            return { role: "user", content: 
              `[DELEGATION RESPONSE from ${responderName}]:\n${processedContent}\n[END DELEGATION RESPONSE]`
            };
          }
        }
      } catch (error) {
        // If registry is not initialized, continue with normal processing
        logger.debug("[MESSAGE_BUILDER] Could not check for external delegation context", { error });
      }
    }

    // User message - check if it's targeted to specific agents
    if (isEventFromUser(event)) {
      const targetedAgentSlugs = getTargetedAgentSlugsFromEvent(event);
      
      // Get the user's display name
      const userName = await nameRepo.getName(event.pubkey);
      
      // If the message targets specific agents and this agent is NOT one of them
      if (targetedAgentSlugs.length > 0 && !targetedAgentSlugs.includes(targetAgentSlug)) {
        
        logger.debug("[MESSAGE_BUILDER] Formatting targeted message for non-recipient agent", {
          eventId: event.id,
          userName,
          targetedAgents: targetedAgentSlugs,
          viewingAgent: targetAgentSlug,
          messageType: "system"
        });
        
        // Format as a system message showing it was directed to other agents (using user name and agent slugs)
        return { role: "system", content: `[${userName} → ${targetedAgentSlugs.join(', ')}]: ${processedContent}` };
      }
      
      // This agent IS a target or it's a broadcast message to all
      logger.debug("[MESSAGE_BUILDER] Formatting message for recipient/broadcast", {
        eventId: event.id,
        userName,
        targetedAgents: targetedAgentSlugs,
        viewingAgent: targetAgentSlug,
        isTargeted: targetedAgentSlugs.includes(targetAgentSlug),
        isBroadcast: targetedAgentSlugs.length === 0,
        messageType: "user"
      });
      
      return { role: "user", content: processedContent };
    }

    // Another agent's message - check if it's targeted to specific agents
    const sendingAgentSlug = eventAgentSlug || "unknown";
    
    // Get the targeted agents from p-tags (if any)
    const targetedAgentSlugs = getTargetedAgentSlugsFromEvent(event);
    
    // Check if this message is specifically targeted to this agent
    if (targetedAgentSlugs.length > 0) {
      if (targetedAgentSlugs.includes(targetAgentSlug)) {
        // This agent is specifically targeted - format as a directed message
        
        logger.debug("[MESSAGE_BUILDER] Formatting targeted agent-to-agent message", {
          eventId: event.id,
          from: sendingAgentSlug,
          to: targetAgentSlug,
          viewingAgent: targetAgentSlug,
          messageType: "user"
        });
        
        // Use 'user' role so the agent knows to respond, with clear sender → recipient format
        return { role: "user", content: `[${sendingAgentSlug} → @${targetAgentSlug}]: ${processedContent}` };
      } else {
        // This agent is NOT targeted - they're just observing
        
        logger.debug("[MESSAGE_BUILDER] Formatting agent-to-agent message for non-recipient", {
          eventId: event.id,
          from: sendingAgentSlug,
          to: targetedAgentSlugs,
          viewingAgent: targetAgentSlug,
          messageType: "system"
        });
        
        // Use 'system' role since this agent is just observing
        return { role: "system", content: `[${sendingAgentSlug} → ${targetedAgentSlugs.join(', ')}]: ${processedContent}` };
      }
    }
    
    // No specific target - broadcast to all agents (including this one)
    logger.debug("[MESSAGE_BUILDER] Formatting broadcast agent message", {
      eventId: event.id,
      from: sendingAgentSlug,
      viewingAgent: targetAgentSlug,
      messageType: "system"
    });
    
    // Use 'system' role for broadcast messages from other agents (no "→ All" suffix)
    return { role: "system", content: `[${sendingAgentSlug}]: ${processedContent}` };
  }

  /**
   * Build phase transition message
   */
  static buildPhaseTransitionMessage(fromPhase: Phase | undefined, toPhase: Phase): string {
    if (fromPhase) {
      return `=== PHASE TRANSITION: ${fromPhase.toUpperCase()} → ${toPhase.toUpperCase()} ===`;
    }
    return `=== CURRENT PHASE: ${toPhase.toUpperCase()} ===`;
  }

  /**
   * Format a system message with proper attribution
   */
  static formatSystemMessage(content: string, attribution?: string): Message {
    if (attribution) {
      return { role: "system", content: `[${attribution}]: ${content}` };
    }
    return { role: "system", content };
  }

  /**
   * Create a user message
   */
  static formatUserMessage(content: string): Message {
    return { role: "user", content };
  }

  /**
   * Create an assistant message
   */
  static formatAssistantMessage(content: string): Message {
    return { role: "assistant", content };
  }

  /**
   * Check if content contains nostr entities
   */
  static hasNostrEntities(content: string): boolean {
    return MessageBuilder.NOSTR_ENTITY_REGEX.test(content);
  }

  /**
   * Extract nostr entities from content
   */
  static extractNostrEntities(content: string): string[] {
    const matches = content.match(MessageBuilder.NOSTR_ENTITY_REGEX);
    return matches || [];
  }

  /**
   * Build "Messages While You Were Away" block for catching up on conversation history
   */
  static async buildMissedMessagesBlock(
    events: NDKEvent[], 
    agentSlug: string,
    delegationSummary?: string
  ): Promise<CoreMessage> {
    let contextBlock = "=== MESSAGES WHILE YOU WERE AWAY ===\n\n";

    if (delegationSummary) {
      contextBlock += `**Previous context**: ${delegationSummary}\n\n`;
    }

    for (const event of events) {
      const sender = MessageBuilder.getEventSender(event, agentSlug);
      if (sender && event.content) {
        const processed = await MessageBuilder.processNostrEntities(event.content);
        contextBlock += `${sender}:\n${processed}\n\n`;
      }
    }

    contextBlock += "=== END OF HISTORY ===\n";
    contextBlock += "Respond to the most recent user message above, considering the context.\n\n";

    return { role: "system", content: contextBlock };
  }

  /**
   * Build delegation responses block
   */
  static buildDelegationResponsesBlock(
    responses: Map<string, NDKEvent>, 
    originalRequest: string
  ): CoreMessage {
    let message = "=== DELEGATE RESPONSES RECEIVED ===\n\n";
    message += `You previously delegated the following request to ${responses.size} agent(s):\n`;
    message += `"${originalRequest}"\n\n`;
    message += "Here are all the responses:\n\n";

    const projectCtx = getProjectContext();
    for (const [pubkey, event] of responses) {
      const agent = projectCtx.getAgentByPubkey(pubkey);
      const agentName = agent?.name || pubkey.substring(0, 8);
      message += `### Response from ${agentName}:\n`;
      message += `${event.content}\n\n`;
    }

    message += "=== END OF DELEGATE RESPONSES ===\n\n";
    message += "Now process these responses and complete your task.";

    return { role: "system", content: message };
  }

  /**
   * Helper to determine event sender for display purposes
   */
  private static getEventSender(event: NDKEvent, currentAgentSlug: string): string | null {
    const eventAgentSlug = getAgentSlugFromEvent(event);

    if (isEventFromUser(event)) {
      return "🟢 USER";
    }
    if (eventAgentSlug) {
      const projectCtx = getProjectContext();
      const sendingAgent = projectCtx.agents.get(eventAgentSlug);
      const agentName = sendingAgent ? sendingAgent.name : "Another agent";

      // Mark the agent's own previous messages clearly
      if (eventAgentSlug === currentAgentSlug) {
        return `💬 You (${agentName})`;
      }
      return `💬 ${agentName}`;
    }
    return "💬 Unknown";
  }
}
