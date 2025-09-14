import { getAgentSlugFromEvent, isEventFromUser } from "@/nostr/utils";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { getPubkeyNameRepository } from "@/services/PubkeyNameRepository";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

/**
 * Handles message role assignment based on event context
 * Single Responsibility: Determine the appropriate role for messages in conversations
 */

// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export  class MessageRoleAssigner {
    /**
     * Format an NDKEvent as a Message for a specific agent
     */
    static async assignRole(
        event: NDKEvent,
        processedContent: string,
        targetAgentPubkey: string,
        conversationId?: string
    ): Promise<ModelMessage> {
        const nameRepo = getPubkeyNameRepository();

        // Agent's own message
        if (event.pubkey === targetAgentPubkey) {
            return { role: "assistant", content: processedContent };
        }

        // Check if this is an external delegation response
        if (conversationId && !isEventFromUser(event) && isProjectContextInitialized()) {
            try {
                const registry = DelegationRegistry.getInstance();
                const projectCtx = getProjectContext();

                // Check if there's a delegation record for this conversation
                const delegationContext = registry.getDelegationByConversationKey(
                    conversationId,
                    targetAgentPubkey,
                    event.pubkey
                );
                    
                if (delegationContext && delegationContext.status === "pending") {
                    // This is a response to an external delegation
                    const responderName = await nameRepo.getName(event.pubkey);
                    const targetAgentName = await nameRepo.getName(targetAgentPubkey);

                    logger.info("[MessageRoleAssigner] Formatting external delegation response", {
                        conversationId: conversationId.substring(0, 8),
                        delegatingAgent: targetAgentName,
                        respondingAgent: responderName,
                        delegationEventId: delegationContext.delegationEventId.substring(0, 8),
                    });

                    // Format as a delegation response with clear context
                    return { role: "user", content:
                        `[DELEGATION RESPONSE from ${responderName}]:\n${processedContent}\n[END DELEGATION RESPONSE]`
                    };
                }
            } catch (error) {
                // If registry is not initialized, continue with normal processing
                logger.debug("[MessageRoleAssigner] Could not check for external delegation context", { error });
            }
        }

        // User message - check if it's targeted to specific agents
        if (isEventFromUser(event)) {
            const targetedAgentPubkeys = this.getTargetedAgentPubkeys(event);

            // Get the user's display name
            const userName = await nameRepo.getName(event.pubkey);

            // If the message targets specific agents and this agent is NOT one of them
            if (targetedAgentPubkeys.length > 0 && !targetedAgentPubkeys.includes(targetAgentPubkey)) {
                
                // Get names for targeted agents
                const targetedAgentNames = await Promise.all(
                    targetedAgentPubkeys.map(pk => nameRepo.getName(pk))
                );

                logger.debug("[MessageRoleAssigner] Formatting targeted message for non-recipient agent", {
                    eventId: event.id,
                    userName,
                    targetedAgents: targetedAgentNames,
                    viewingAgent: await nameRepo.getName(targetAgentPubkey),
                    messageType: "system"
                });

                // Format as a system message showing it was directed to other agents
                return { role: "system", content: `[User (${userName}) → ${targetedAgentNames.join(', ')}]: ${processedContent}` };
            }
            
            // This agent IS a target or it's a broadcast message to all
            logger.debug("[MessageRoleAssigner] Formatting message for recipient/broadcast", {
                eventId: event.id,
                userName,
                targetedAgents: targetedAgentPubkeys,
                viewingAgent: targetAgentPubkey,
                isTargeted: targetedAgentPubkeys.includes(targetAgentPubkey),
                isBroadcast: targetedAgentPubkeys.length === 0,
                messageType: "user"
            });

            return { role: "user", content: processedContent };
        }

        // Another agent's message - check if it's targeted to specific agents
        const sendingAgentName = await nameRepo.getName(event.pubkey);

        // Get the targeted agents from p-tags (if any)
        const targetedAgentPubkeys = this.getTargetedAgentPubkeys(event);

        // Check if this message is specifically targeted to this agent
        if (targetedAgentPubkeys.length > 0) {
            if (targetedAgentPubkeys.includes(targetAgentPubkey)) {
                // This agent is specifically targeted - format as a directed message
                const targetAgentName = await nameRepo.getName(targetAgentPubkey);

                logger.debug("[MessageRoleAssigner] Formatting targeted agent-to-agent message", {
                    eventId: event.id,
                    from: sendingAgentName,
                    to: targetAgentName,
                    viewingAgent: targetAgentName,
                    messageType: "user"
                });

                // Use 'user' role so the agent knows to respond, with clear sender → recipient format
                return { role: "user", content: `[${sendingAgentName} → @${targetAgentName}]: ${processedContent}` };
            } else {
                // This agent is NOT targeted - they're just observing
                const targetedAgentNames = await Promise.all(
                    targetedAgentPubkeys.map(pk => nameRepo.getName(pk))
                );

                logger.debug("[MessageRoleAssigner] Formatting agent-to-agent message for non-recipient", {
                    eventId: event.id,
                    from: sendingAgentName,
                    to: targetedAgentNames,
                    viewingAgent: await nameRepo.getName(targetAgentPubkey),
                    messageType: "system"
                });

                // Use 'system' role since this agent is just observing
                return { role: "system", content: `[${sendingAgentName} → ${targetedAgentNames.join(', ')}]: ${processedContent}` };
            }
        }
        
        // No specific target - broadcast to all agents (including this one)
        logger.debug("[MessageRoleAssigner] Formatting broadcast agent message", {
            eventId: event.id,
            from: sendingAgentName,
            viewingAgent: await nameRepo.getName(targetAgentPubkey),
            messageType: "system"
        });

        // Use 'system' role for broadcast messages from other agents
        return { role: "system", content: `[${sendingAgentName}]: ${processedContent}` };
    }

    /**
     * Get the pubkeys of agents targeted by this event based on p-tags
     */
    private static getTargetedAgentPubkeys(event: NDKEvent): string[] {
        if (!isProjectContextInitialized()) {
            return [];
        }

        const projectCtx = getProjectContext();
        const targetedPubkeys: string[] = [];

        // Get all p-tags from the event
        const pTags = event.getMatchingTags("p");
        if (pTags.length === 0) {
            return [];
        }

        // Check each p-tag to see if it matches an agent
        for (const pTag of pTags) {
            const pubkey = pTag[1];
            if (!pubkey) continue;

            // Check if this pubkey belongs to an agent
            for (const agent of projectCtx.agents.values()) {
                if (agent.pubkey === pubkey) {
                    targetedPubkeys.push(pubkey);
                    break;
                }
            }
        }

        return targetedPubkeys;
    }
}