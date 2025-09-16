import type { AgentInstance } from "@/agents/types";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { ExecutionContext } from "@/agents/execution/types";
import { ConversationCoordinator } from "@/conversations";
import { ConversationResolver } from "@/conversations/services/ConversationResolver";
import { configService } from "@/services/ConfigService";
import type { ProjectContext } from "@/services/ProjectContext";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import { getNDK } from "@/nostr/ndkClient";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

interface BrainstormResponse {
    agent: AgentInstance;
    content: string;
    llmRequestPayload: any;
}

/**
 * Stateless service for handling brainstorming operations.
 * Orchestrates multi-agent brainstorming with moderation.
 */
export class BrainstormService {
    constructor(
        private projectContext: ProjectContext
    ) {}

    /**
     * Start a brainstorming session from a kind:11 event with ["mode", "brainstorm"] tag
     */
    async start(event: NDKEvent): Promise<void> {
        logger.info("[BrainstormService] Starting brainstorming session", {
            eventId: event.id?.substring(0, 8),
            content: event.content?.substring(0, 50)
        });

        // 1. Parse moderator and participants from event
        const moderatorPubkey = AgentEventDecoder.getModerator(event);
        const participantPubkeys = AgentEventDecoder.getParticipants(event);

        if (!moderatorPubkey) {
            logger.error("[BrainstormService] No moderator found in brainstorm event");
            return;
        }

        const moderator = this.projectContext.getAgentByPubkey(moderatorPubkey);
        if (!moderator) {
            logger.error("[BrainstormService] Moderator agent not found", { moderatorPubkey });
            return;
        }

        // 2. Get participant agents
        const participants: AgentInstance[] = [];
        for (const pubkey of participantPubkeys) {
            const agent = this.projectContext.getAgentByPubkey(pubkey);
            if (agent) {
                participants.push(agent);
            } else {
                logger.warn("[BrainstormService] Participant agent not found", { pubkey });
            }
        }

        if (participants.length === 0) {
            logger.error("[BrainstormService] No valid participants found");
            return;
        }

        logger.info("[BrainstormService] Brainstorm participants", {
            moderator: moderator.name,
            participants: participants.map(p => p.name)
        });

        // 3. Create conversation for this brainstorm
        const conversationCoordinator = new ConversationCoordinator(
            this.projectContext.agentRegistry.getBasePath()
        );
        await conversationCoordinator.initialize();
        
        const conversation = await conversationCoordinator.createConversation(event);

        // 4. Collect responses from each participant
        const responses: BrainstormResponse[] = [];
        
        for (const participant of participants) {
            try {
                logger.info("[BrainstormService] Getting response from participant", {
                    participant: participant.name
                });

                // Create execution context for this participant
                const executionContext: ExecutionContext = {
                    agent: participant,
                    conversationId: conversation.id,
                    projectPath: this.projectContext.agentRegistry.getBasePath(),
                    triggeringEvent: event,
                    conversationCoordinator,
                };

                // Use AgentExecutor to prepare LLM request
                const agentExecutor = new AgentExecutor();
                const llmRequest = await agentExecutor.prepareLLMRequest(
                    participant,
                    event.content || "",
                    event,
                    [] // No conversation history for initial brainstorm
                );

                // Execute LLM call to get participant's response
                const llmLogger = this.projectContext.llmLogger.withAgent(participant.name);
                const llmService = configService.createLLMService(
                    llmLogger,
                    participant.llmConfig
                );

                const result = await llmService.complete(
                    llmRequest.messages,
                    llmRequest.tools || {}
                );

                responses.push({
                    agent: participant,
                    content: result.text,
                    llmRequestPayload: llmRequest
                });

                logger.info("[BrainstormService] Got response from participant", {
                    participant: participant.name,
                    responseLength: result.text.length
                });

            } catch (error) {
                logger.error("[BrainstormService] Failed to get response from participant", {
                    participant: participant.name,
                    error
                });
            }
        }

        if (responses.length === 0) {
            logger.error("[BrainstormService] No responses collected from participants");
            return;
        }

        // 5. Have moderator choose the best response
        const moderationPrompt = this.buildModerationPrompt(event.content || "", responses);
        
        const moderatorLogger = this.projectContext.llmLogger.withAgent(moderator.name);
        const moderatorLLMService = configService.createLLMService(
            moderatorLogger,
            moderator.llmConfig
        );

        const moderationResult = await moderatorLLMService.complete([
            {
                role: "system",
                content: "You are a moderator choosing the best response. Respond ONLY with valid JSON in the format: {\"chosen_option\": <number>, \"reason\": \"<explanation>\"}"
            },
            {
                role: "user",
                content: moderationPrompt
            }
        ], {});

        // 6. Parse moderation result
        let chosenIndex = 0;
        let reason = "Default selection";
        
        try {
            const parsed = JSON.parse(moderationResult.text);
            chosenIndex = (parsed.chosen_option - 1); // Convert 1-based to 0-based
            reason = parsed.reason || "No reason provided";
            
            // Validate index
            if (chosenIndex < 0 || chosenIndex >= responses.length) {
                logger.warn("[BrainstormService] Invalid chosen index, defaulting to first", {
                    chosenIndex,
                    responseCount: responses.length
                });
                chosenIndex = 0;
            }
        } catch (error) {
            logger.error("[BrainstormService] Failed to parse moderation result, using first response", {
                error,
                result: moderationResult.text
            });
        }

        logger.info("[BrainstormService] Moderator chose response", {
            chosenIndex,
            chosenAgent: responses[chosenIndex].agent.name,
            reason
        });

        // 7. Publish chosen response and mark others as not-chosen
        const eventContext: EventContext = {
            triggeringEvent: event,
            rootEvent: event,
            conversationId: conversation.id,
        };

        for (let i = 0; i < responses.length; i++) {
            const response = responses[i];
            const publisher = new AgentPublisher(response.agent);
            
            if (i === chosenIndex) {
                // Publish as the chosen response
                await publisher.conversation(
                    { content: response.content },
                    eventContext
                );
                
                logger.info("[BrainstormService] Published chosen response", {
                    agent: response.agent.name
                });
            } else {
                // Publish as not-chosen (with special tag)
                const ndk = getNDK();
                const notChosenEvent = new NDKEvent(ndk);
                notChosenEvent.content = response.content;
                notChosenEvent.kind = 1111; // GenericReply
                notChosenEvent.tags = [
                    ["e", event.id],
                    ["not-chosen"] // Special tag to mark as not chosen
                ];
                
                await response.agent.sign(notChosenEvent);
                await notChosenEvent.publish();
                
                logger.info("[BrainstormService] Published not-chosen response", {
                    agent: response.agent.name
                });
            }
        }

        logger.info("[BrainstormService] Brainstorming session completed");
    }

    /**
     * Handle follow-up responses to brainstorm events
     */
    async handleFollowUp(event: NDKEvent): Promise<void> {
        logger.info("[BrainstormService] Handling brainstorm follow-up", {
            eventId: event.id?.substring(0, 8),
            content: event.content?.substring(0, 50)
        });

        // 1. Create conversation coordinator
        const conversationCoordinator = new ConversationCoordinator(
            this.projectContext.agentRegistry.getBasePath()
        );
        await conversationCoordinator.initialize();

        // 2. Resolve conversation thread
        const resolver = new ConversationResolver(conversationCoordinator);
        const { conversation } = await resolver.resolveConversationForEvent(event);
        
        if (!conversation) {
            logger.error("[BrainstormService] Could not resolve conversation for follow-up");
            return;
        }

        // 3. Find the original brainstorm event (root) and winning response
        const rootEvent = conversation.history[0];
        if (!rootEvent || !this.isBrainstormEvent(rootEvent)) {
            logger.error("[BrainstormService] Root event is not a brainstorm event");
            return;
        }

        // Find the winning response (first reply without "not-chosen" tag)
        let winningResponse: NDKEvent | undefined;
        for (const historyEvent of conversation.history) {
            if (historyEvent.tagValue("e") === rootEvent.id && !historyEvent.tagValue("not-chosen")) {
                winningResponse = historyEvent;
                break;
            }
        }

        if (!winningResponse) {
            logger.error("[BrainstormService] Could not find winning response in brainstorm");
            return;
        }

        // 4. Get moderator
        const moderatorPubkey = AgentEventDecoder.getModerator(rootEvent);
        if (!moderatorPubkey) {
            logger.error("[BrainstormService] No moderator found in original brainstorm");
            return;
        }

        const moderator = this.projectContext.getAgentByPubkey(moderatorPubkey);
        if (!moderator) {
            logger.error("[BrainstormService] Moderator agent not found");
            return;
        }

        // 5. Build moderation prompt for follow-up
        const followUpModerationPrompt = this.buildFollowUpModerationPrompt(
            rootEvent.content || "",
            winningResponse.content || "",
            event.content || ""
        );

        // 6. Have moderator evaluate if follow-up is valuable
        const moderatorLogger = this.projectContext.llmLogger.withAgent(moderator.name);
        const moderatorLLMService = configService.createLLMService(
            moderatorLogger,
            moderator.llmConfig
        );

        const moderationResult = await moderatorLLMService.complete([
            {
                role: "system",
                content: "You are evaluating if a follow-up comment adds value to a brainstorm discussion. Respond ONLY with valid JSON: {\"is_valuable\": true/false, \"reason\": \"<explanation>\"}"
            },
            {
                role: "user",
                content: followUpModerationPrompt
            }
        ], {});

        // 7. Parse moderation result
        let isValuable = false;
        let reason = "Not evaluated";
        
        try {
            const parsed = JSON.parse(moderationResult.text);
            isValuable = parsed.is_valuable === true;
            reason = parsed.reason || "No reason provided";
        } catch (error) {
            logger.error("[BrainstormService] Failed to parse follow-up moderation result", {
                error,
                result: moderationResult.text
            });
        }

        logger.info("[BrainstormService] Moderator evaluated follow-up", {
            isValuable,
            reason
        });

        // 8. If valuable, publish as reply to winning response
        if (isValuable) {
            // Get the author of the follow-up
            const authorAgent = this.projectContext.getAgentByPubkey(event.pubkey);
            if (!authorAgent) {
                logger.warn("[BrainstormService] Follow-up author is not a system agent");
                return;
            }

            const publisher = new AgentPublisher(authorAgent);
            const eventContext: EventContext = {
                triggeringEvent: winningResponse, // Reply to winning response
                rootEvent: rootEvent,
                conversationId: conversation.id,
            };

            await publisher.conversation(
                { content: event.content || "" },
                eventContext
            );

            logger.info("[BrainstormService] Published valuable follow-up");
        } else {
            logger.info("[BrainstormService] Follow-up deemed not valuable, not publishing");
        }
    }

    /**
     * Check if an event is a brainstorm event
     */
    private isBrainstormEvent(event: NDKEvent): boolean {
        if (event.kind !== 11) return false;
        
        const modeTags = event.tags.filter(tag => tag[0] === "mode" && tag[1] === "brainstorm");
        return modeTags.length > 0;
    }

    /**
     * Build moderation prompt for choosing best response
     */
    private buildModerationPrompt(originalPrompt: string, responses: BrainstormResponse[]): string {
        let prompt = `Original question/prompt:\n${originalPrompt}\n\n`;
        prompt += `You have ${responses.length} responses to choose from:\n\n`;
        
        for (let i = 0; i < responses.length; i++) {
            prompt += `Option ${i + 1} (from ${responses[i].agent.name}):\n`;
            prompt += `${responses[i].content}\n\n`;
        }
        
        prompt += "Choose the BEST response based on accuracy, completeness, clarity, and relevance. ";
        prompt += "Respond with JSON only.";
        
        return prompt;
    }

    /**
     * Build moderation prompt for evaluating follow-up
     */
    private buildFollowUpModerationPrompt(
        originalPrompt: string,
        winningResponse: string,
        followUp: string
    ): string {
        return `Original brainstorm prompt:\n${originalPrompt}\n\n` +
               `Winning response:\n${winningResponse}\n\n` +
               `Follow-up comment:\n${followUp}\n\n` +
               `Evaluate if this follow-up adds significant value, provides important corrections, ` +
               `or contributes meaningful insights to the discussion. ` +
               `Be selective - only approve truly valuable additions.`;
    }
}