import { getTargetedAgentPubkeys, isEventFromUser } from "@/nostr/utils";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { isProjectContextInitialized } from "@/services";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { getPubkeyNameRepository } from "@/services/PubkeyNameRepository";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

/**
 * Transforms NDKEvents into model messages for LLM consumption
 * Single Responsibility: Convert Nostr events to properly formatted LLM messages
 */

// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export class EventToModelMessage {
    /**
     * Transform an NDKEvent into a prompt message for the LLM
     * Can return multiple messages if phase transition is detected
     */
    static async transform(
        event: NDKEvent,
        processedContent: string,
        targetAgentPubkey: string,
        conversationId?: string
    ): Promise<ModelMessage | ModelMessage[]> {
        const messages: ModelMessage[] = [];

        // Check for phase transition before processing the event
        const phaseTag = event.tagValue("phase");
        const phaseInstructionsTag = event.tagValue("phase-instructions");

        if (phaseTag) {
            // This event marks a phase transition
            // Check if this agent is p-tagged on the event
            const targetedAgentPubkeys = getTargetedAgentPubkeys(event);
            const isTargetedAgent = targetedAgentPubkeys.includes(targetAgentPubkey);

            let phaseContent: string;
            if (isTargetedAgent) {
                // Show full phase transition with instructions for targeted agent
                phaseContent =
                    PromptBuilder.buildFragment("phase-transition", {
                        phase: phaseTag,
                        phaseInstructions: phaseInstructionsTag,
                    }) || "";
            } else {
                // Only show phase name for non-targeted agents
                phaseContent = `=== PHASE TRANSITION: ${phaseTag.toUpperCase()} ===`;
            }

            if (phaseContent) {
                messages.push({ role: "system", content: phaseContent });
            }
        }

        // Process the event content normally
        const mainMessage = await EventToModelMessage.transformEventContent(
            event,
            processedContent,
            targetAgentPubkey,
            conversationId
        );

        messages.push(mainMessage);

        // Return single message if no phase transition, otherwise return array
        return messages.length === 1 ? messages[0] : messages;
    }

    /**
     * Transform the event content (without phase handling)
     */
    private static async transformEventContent(
        event: NDKEvent,
        processedContent: string,
        targetAgentPubkey: string,
        conversationId?: string
    ): Promise<ModelMessage> {
        // Agent's own message - simple case
        if (event.pubkey === targetAgentPubkey) {
            return { role: "assistant", content: processedContent };
        }

        // Check for delegation response
        const delegationMessage = await EventToModelMessage.checkDelegationResponse(
            event,
            processedContent,
            targetAgentPubkey,
            conversationId
        );
        if (delegationMessage) return delegationMessage;

        // Determine role and format based on sender and targeting
        return await EventToModelMessage.formatByTargeting(
            event,
            processedContent,
            targetAgentPubkey
        );
    }

    /**
     * Check if this is a delegation response and format accordingly
     */
    private static async checkDelegationResponse(
        event: NDKEvent,
        processedContent: string,
        targetAgentPubkey: string,
        conversationId?: string
    ): Promise<ModelMessage | null> {
        if (!conversationId || isEventFromUser(event) || !isProjectContextInitialized()) {
            return null;
        }

        try {
            const registry = DelegationRegistry.getInstance();

            // Check if there's a delegation record for this conversation
            const delegationContext = registry.getDelegationByConversationKey(
                conversationId,
                targetAgentPubkey,
                event.pubkey
            );

            if (delegationContext && delegationContext.status === "pending") {
                // This is a response to an external delegation
                const nameRepo = getPubkeyNameRepository();
                const responderName = await nameRepo.getName(event.pubkey);
                const targetAgentName = await nameRepo.getName(targetAgentPubkey);

                logger.info("[EventToModelMessage] Formatting external delegation response", {
                    conversationId: conversationId.substring(0, 8),
                    delegatingAgent: targetAgentName,
                    respondingAgent: responderName,
                    delegationEventId: delegationContext.delegationEventId.substring(0, 8),
                });

                // Format as a delegation response with clear context
                return {
                    role: "user",
                    content: `[DELEGATION RESPONSE from ${responderName}]:\n${processedContent}\n[END DELEGATION RESPONSE]`,
                };
            }
        } catch (error) {
            // If registry is not initialized, continue with normal processing
            logger.debug("[EventToModelMessage] Could not check for external delegation context", {
                error,
            });
        }

        return null;
    }

    /**
     * Format message based on targeting information
     */
    private static async formatByTargeting(
        event: NDKEvent,
        processedContent: string,
        targetAgentPubkey: string
    ): Promise<ModelMessage> {
        const nameRepo = getPubkeyNameRepository();

        // User message - check if it's targeted to specific agents
        if (isEventFromUser(event)) {
            const targetedAgentPubkeys = getTargetedAgentPubkeys(event);

            // Get the user's display name
            const userName = await nameRepo.getName(event.pubkey);

            // If the message targets specific agents and this agent is NOT one of them
            if (
                targetedAgentPubkeys.length > 0 &&
                !targetedAgentPubkeys.includes(targetAgentPubkey)
            ) {
                // Get names for targeted agents
                const targetedAgentNames = await Promise.all(
                    targetedAgentPubkeys.map((pk) => nameRepo.getName(pk))
                );

                logger.debug(
                    "[EventToModelMessage] Formatting targeted message for non-recipient agent",
                    {
                        eventId: event.id,
                        userName,
                        targetedAgents: targetedAgentNames,
                        viewingAgent: await nameRepo.getName(targetAgentPubkey),
                        messageType: "system",
                    }
                );

                // Format as a system message showing it was directed to other agents
                return {
                    role: "system",
                    content: `[User (${userName}) → ${targetedAgentNames.join(", ")}]: ${processedContent}`,
                };
            }

            // This agent IS a target or it's a broadcast message to all
            logger.debug("[EventToModelMessage] Formatting message for recipient/broadcast", {
                eventId: event.id,
                userName,
                targetedAgents: targetedAgentPubkeys,
                viewingAgent: targetAgentPubkey,
                isTargeted: targetedAgentPubkeys.includes(targetAgentPubkey),
                isBroadcast: targetedAgentPubkeys.length === 0,
                messageType: "user",
            });

            return { role: "user", content: processedContent };
        }

        // Another agent's message - check if it's targeted to specific agents
        const sendingAgentName = await nameRepo.getName(event.pubkey);

        // Get the targeted agents from p-tags (if any)
        const targetedAgentPubkeys = getTargetedAgentPubkeys(event);

        // Check if this message is specifically targeted to this agent
        if (targetedAgentPubkeys.length > 0) {
            if (targetedAgentPubkeys.includes(targetAgentPubkey)) {
                // This agent is specifically targeted - format as a directed message
                const targetAgentName = await nameRepo.getName(targetAgentPubkey);

                logger.debug("[EventToModelMessage] Formatting targeted agent-to-agent message", {
                    eventId: event.id,
                    from: sendingAgentName,
                    to: targetAgentName,
                    viewingAgent: targetAgentName,
                    messageType: "user",
                });

                // Use 'user' role so the agent knows to respond, with clear sender → recipient format
                return {
                    role: "user",
                    content: `[${sendingAgentName} → @${targetAgentName}]: ${processedContent}`,
                };
            }
            // This agent is NOT targeted - they're just observing
            const targetedAgentNames = await Promise.all(
                targetedAgentPubkeys.map((pk) => nameRepo.getName(pk))
            );

            logger.debug(
                "[EventToModelMessage] Formatting agent-to-agent message for non-recipient",
                {
                    eventId: event.id,
                    from: sendingAgentName,
                    to: targetedAgentNames,
                    viewingAgent: await nameRepo.getName(targetAgentPubkey),
                    messageType: "system",
                }
            );

            // Use 'system' role since this agent is just observing
            return {
                role: "system",
                content: `[${sendingAgentName} → ${targetedAgentNames.join(", ")}]: ${processedContent}`,
            };
        }

        // No specific target - broadcast to all agents (including this one)
        logger.debug("[EventToModelMessage] Formatting broadcast agent message", {
            eventId: event.id,
            from: sendingAgentName,
            viewingAgent: await nameRepo.getName(targetAgentPubkey),
            messageType: "system",
        });

        // Use 'system' role for broadcast messages from other agents
        return { role: "system", content: `[${sendingAgentName}]: ${processedContent}` };
    }
}
