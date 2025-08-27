import { getNDK } from "@/nostr";
import { getAgentSlugFromEvent, getTargetedAgentSlugsFromEvent, isEventFromUser } from "@/nostr/utils";
import { getProjectContext } from "@/services";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { getPubkeyNameRepository } from "@/services/PubkeyNameRepository";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { Message } from "multi-llm-ts";
import type { Phase } from "./phases";

/**
 * Handles message formatting and processing.
 * Single Responsibility: Transform events and content into properly formatted messages.
 */
export class MessageBuilder {
  private static readonly NOSTR_ENTITY_REGEX = /nostr:(nevent1|naddr1|note1|npub1|nprofile1)\w+/g;

  /**
   * Process nostr entities in content, replacing them with inline content
   */
  async processNostrEntities(content: string): Promise<string> {
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
  async formatEventAsMessage(
    event: NDKEvent,
    processedContent: string,
    targetAgentSlug: string,
    conversationId?: string
  ): Promise<Message> {
    const eventAgentSlug = getAgentSlugFromEvent(event);
    const nameRepo = getPubkeyNameRepository();
    const projectCtx = getProjectContext();

    // Agent's own message
    if (eventAgentSlug === targetAgentSlug) {
      return new Message("assistant", processedContent);
    }

    // Check if this is an external delegation response
    if (conversationId && !isEventFromUser(event)) {
      try {
        const registry = DelegationRegistry.getInstance();
        const targetAgent = projectCtx.getAgent(targetAgentSlug);
        
        if (targetAgent) {
          // Check if there's a delegation record for this conversation
          const delegationContext = registry.getDelegationContext(
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
            return new Message("user", 
              `[DELEGATION RESPONSE from ${responderName}]:\n${processedContent}\n[END DELEGATION RESPONSE]`
            );
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
        return new Message("system", `[${userName} → ${targetedAgentSlugs.join(', ')}]: ${processedContent}`);
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
      
      return new Message("user", processedContent);
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
        return new Message("user", `[${sendingAgentSlug} → @${targetAgentSlug}]: ${processedContent}`);
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
        return new Message("system", `[${sendingAgentSlug} → ${targetedAgentSlugs.join(', ')}]: ${processedContent}`);
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
    return new Message("system", `[${sendingAgentSlug}]: ${processedContent}`);
  }

  /**
   * Build phase transition message
   */
  buildPhaseTransitionMessage(fromPhase: Phase | undefined, toPhase: Phase): string {
    if (fromPhase) {
      return `=== PHASE TRANSITION: ${fromPhase.toUpperCase()} → ${toPhase.toUpperCase()} ===`;
    }
    return `=== CURRENT PHASE: ${toPhase.toUpperCase()} ===`;
  }

  /**
   * Format a system message with proper attribution
   */
  formatSystemMessage(content: string, attribution?: string): Message {
    if (attribution) {
      return new Message("system", `[${attribution}]: ${content}`);
    }
    return new Message("system", content);
  }

  /**
   * Create a user message
   */
  formatUserMessage(content: string): Message {
    return new Message("user", content);
  }

  /**
   * Create an assistant message
   */
  formatAssistantMessage(content: string): Message {
    return new Message("assistant", content);
  }

  /**
   * Check if content contains nostr entities
   */
  hasNostrEntities(content: string): boolean {
    return MessageBuilder.NOSTR_ENTITY_REGEX.test(content);
  }

  /**
   * Extract nostr entities from content
   */
  extractNostrEntities(content: string): string[] {
    const matches = content.match(MessageBuilder.NOSTR_ENTITY_REGEX);
    return matches || [];
  }
}
