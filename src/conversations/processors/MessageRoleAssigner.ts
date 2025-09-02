import { getAgentSlugFromEvent, getTargetedAgentSlugsFromEvent, isEventFromUser } from "@/nostr/utils";
import { getProjectContext } from "@/services";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { getPubkeyNameRepository } from "@/services/PubkeyNameRepository";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

/**
 * Handles message role assignment based on event context
 * Single Responsibility: Determine the appropriate role for messages in conversations
 */
export class MessageRoleAssigner {
    /**
     * Format an NDKEvent as a Message for a specific agent
     */
    static async assignRole(
        event: NDKEvent,
        processedContent: string,
        targetAgentSlug: string,
        conversationId?: string
    ): Promise<ModelMessage> {
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
                        
                        logger.info("[MessageRoleAssigner] Formatting external delegation response", {
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
                logger.debug("[MessageRoleAssigner] Could not check for external delegation context", { error });
            }
        }

        // User message - check if it's targeted to specific agents
        if (isEventFromUser(event)) {
            const targetedAgentSlugs = getTargetedAgentSlugsFromEvent(event);
            
            // Get the user's display name
            const userName = await nameRepo.getName(event.pubkey);
            
            // If the message targets specific agents and this agent is NOT one of them
            if (targetedAgentSlugs.length > 0 && !targetedAgentSlugs.includes(targetAgentSlug)) {
                
                logger.debug("[MessageRoleAssigner] Formatting targeted message for non-recipient agent", {
                    eventId: event.id,
                    userName,
                    targetedAgents: targetedAgentSlugs,
                    viewingAgent: targetAgentSlug,
                    messageType: "system"
                });
                
                // Format as a system message showing it was directed to other agents (using user name and agent slugs)
                return { role: "system", content: `[User (${userName}) → ${targetedAgentSlugs.join(', ')}]: ${processedContent}` };
            }
            
            // This agent IS a target or it's a broadcast message to all
            logger.debug("[MessageRoleAssigner] Formatting message for recipient/broadcast", {
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
                
                logger.debug("[MessageRoleAssigner] Formatting targeted agent-to-agent message", {
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
                
                logger.debug("[MessageRoleAssigner] Formatting agent-to-agent message for non-recipient", {
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
        logger.debug("[MessageRoleAssigner] Formatting broadcast agent message", {
            eventId: event.id,
            from: sendingAgentSlug,
            viewingAgent: targetAgentSlug,
            messageType: "system"
        });
        
        // Use 'system' role for broadcast messages from other agents
        return { role: "system", content: `[${sendingAgentSlug}]: ${processedContent}` };
    }
}