import type { AgentInstance } from "@/agents/types";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { ExecutionContext } from "@/agents/execution/types";
import { BrainstormStrategy } from "@/agents/execution/strategies/BrainstormStrategy";
import { ConversationCoordinator } from "@/conversations";
import type { Conversation } from "@/conversations/types";
import { ConversationResolver } from "@/conversations/services/ConversationResolver";
import type { ProjectContext } from "@/services/ProjectContext";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getNDK } from "@/nostr/ndkClient";
import { NostrKind, NostrTag, TagValue, MAX_REASON_LENGTH, isBrainstormEvent } from "@/nostr/constants";
import { logger } from "@/utils/logger";
import { safeParseJSON } from "@/utils/json-parser";
import { NDKEvent } from "@nostr-dev-kit/ndk";

interface BrainstormResponse {
    agent: AgentInstance;
    content: string;
    event: NDKEvent;
}


interface ParsedBrainstormEvent {
    moderator: AgentInstance;
    participants: AgentInstance[];
}

/**
 * Service for handling brainstorming operations.
 * Orchestrates multi-agent brainstorming with moderation.
 */
export class BrainstormService {
    private conversationCoordinator: ConversationCoordinator | null = null;
    
    constructor(
        private projectContext: ProjectContext
    ) {}
    
    /**
     * Get or create a conversation coordinator instance
     */
    private async getConversationCoordinator(): Promise<ConversationCoordinator> {
        if (!this.conversationCoordinator) {
            this.conversationCoordinator = new ConversationCoordinator(
                this.projectContext.agentRegistry.getBasePath()
            );
            await this.conversationCoordinator.initialize();
        }
        return this.conversationCoordinator;
    }

    /**
     * Entry point for starting a brainstorming session
     */
    async start(event: NDKEvent): Promise<void> {
        logger.info("[BrainstormService] Starting brainstorming session", {
            eventId: event.id?.substring(0, 8)
        });
        
        try {
            await this.runBrainstorm(event);
            logger.info("[BrainstormService] Brainstorming session completed");
        } catch (error) {
            logger.error("[BrainstormService] Failed to complete brainstorm", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Orchestrates the complete brainstorming flow
     */
    private async runBrainstorm(event: NDKEvent): Promise<void> {
        // Parse and validate
        const parsed = await this.parseAndValidateBrainstormEvent(event);
        if (!parsed) return;

        const { moderator, participants } = parsed;

        // Create conversation
        const conversation = await this.createConversation(event);
        if (!conversation) return;

        // Execute participants
        const responses = await this.executeParticipants(
            participants,
            event,
            conversation
        );

        if (responses.length === 0) {
            logger.error("[BrainstormService] No responses collected");
            return;
        }

        // Moderate responses
        const moderationResult = await this.runModeration(
            moderator,
            event.content || "",
            responses,
            event,
            conversation
        );

        if (!moderationResult) return;

        // Publish final selection
        // Publish selection events for all chosen responses
        for (const index of moderationResult.chosenIndices) {
            await this.publishModeratorSelection(
                event,
                responses[index],
                moderator,
                conversation.id,
                moderationResult.reason
            );
        }
    }

    /**
     * Extracts moderator and participants from the brainstorm event
     */
    private async parseAndValidateBrainstormEvent(
        event: NDKEvent
    ): Promise<ParsedBrainstormEvent | null> {
        const moderatorPubkey = AgentEventDecoder.getModerator(event);
        if (!moderatorPubkey) {
            logger.error("[BrainstormService] No moderator found in brainstorm event");
            return null;
        }

        const moderator = this.projectContext.getAgentByPubkey(moderatorPubkey);
        if (!moderator) {
            logger.error("[BrainstormService] Moderator agent not found", { moderatorPubkey });
            return null;
        }

        const participantPubkeys = AgentEventDecoder.getParticipants(event);
        const participants = this.resolveParticipants(participantPubkeys);

        if (participants.length === 0) {
            logger.error("[BrainstormService] No valid participants found");
            return null;
        }

        logger.info("[BrainstormService] Brainstorm participants resolved", {
            moderator: moderator.name,
            participants: participants.map(p => p.name)
        });

        return { moderator, participants };
    }

    /**
     * Resolve participant pubkeys to agent instances
     */
    private resolveParticipants(pubkeys: string[]): AgentInstance[] {
        const participants: AgentInstance[] = [];
        
        for (const pubkey of pubkeys) {
            const agent = this.projectContext.getAgentByPubkey(pubkey);
            if (agent) {
                participants.push(agent);
            } else {
                logger.debug("[BrainstormService] Participant agent not found", { 
                    pubkey: pubkey.substring(0, 8) 
                });
            }
        }
        
        return participants;
    }

    /**
     * Create or get conversation for brainstorm
     */
    private async createConversation(event: NDKEvent): Promise<Conversation | null> {
        try {
            const coordinator = await this.getConversationCoordinator();
            return await coordinator.createConversation(event);
        } catch (error) {
            logger.error("[BrainstormService] Failed to create conversation", {
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }

    /**
     * Executes all brainstorm participants in parallel and collects their responses
     */
    private async executeParticipants(
        participants: AgentInstance[],
        event: NDKEvent,
        conversation: Conversation
    ): Promise<BrainstormResponse[]> {
        logger.debug("[BrainstormService] Executing participants", {
            count: participants.length
        });

        const coordinator = await this.getConversationCoordinator();

        // Execute all participants in parallel and get their responses directly
        const results = await Promise.allSettled(
            participants.map(participant =>
                this.executeParticipant(participant, event, conversation, coordinator)
            )
        );

        // Extract successful responses and log failures
        const responses: BrainstormResponse[] = [];
        for (const [index, result] of results.entries()) {
            if (result.status === "fulfilled" && result.value) {
                responses.push(result.value);
            } else if (result.status === "rejected") {
                logger.error("[BrainstormService] Participant execution failed", {
                    participant: participants[index].name,
                    error: result.reason
                });
            } else {
                logger.debug("[BrainstormService] Participant produced no response", {
                    participant: participants[index].name
                });
            }
        }

        return responses;
    }

    /**
     * Executes a single participant agent and returns it with response on success
     */
    private async executeParticipant(
        participant: AgentInstance,
        event: NDKEvent,
        conversation: Conversation,
        coordinator: ConversationCoordinator
    ): Promise<BrainstormResponse | null> {
        logger.debug("[BrainstormService] Executing participant", {
            name: participant.name
        });

        const context: ExecutionContext = {
            agent: participant,
            conversationId: conversation.id,
            projectPath: this.projectContext.agentRegistry.getBasePath(),
            triggeringEvent: event,
            conversationCoordinator: coordinator,
            getConversation: () => coordinator.getConversation(conversation.id),
        };

        const strategy = new BrainstormStrategy();
        const executor = new AgentExecutor(undefined, strategy);
        const responseEvent = await executor.execute(context);

        if (responseEvent?.content) {
            return {
                agent: participant,
                content: responseEvent.content,
                event: responseEvent
            };
        }

        return null;
    }

    /**
     * Runs the moderation process to select the best response(s) from participants
     */
    private async runModeration(
        moderator: AgentInstance,
        originalPrompt: string,
        responses: BrainstormResponse[],
        brainstormRoot: NDKEvent,
        conversation: Conversation
    ): Promise<{ chosenIndices: number[]; reason: string } | null> {
        try {
            logger.debug("[BrainstormService] Running moderation", {
                moderator: moderator.name,
                responseCount: responses.length
            });

            // Execute moderator with full context using the real brainstorm root
            const coordinator = await this.getConversationCoordinator();
            const context: ExecutionContext = {
                agent: moderator,
                conversationId: conversation.id,
                projectPath: this.projectContext.agentRegistry.getBasePath(),
                triggeringEvent: brainstormRoot, // Use the real brainstorm root as triggering event
                conversationCoordinator: coordinator,
                getConversation: () => coordinator.getConversation(conversation.id),
            };

            // Use BrainstormStrategy for proper context building
            const { BrainstormStrategy } = await import("@/agents/execution/strategies/BrainstormStrategy");
            const strategy = new BrainstormStrategy();
            const executor = new AgentExecutor(undefined, strategy);

            // Execute moderation to get structured selection
            const moderationResult = await executor.executeBrainstormModeration(context, responses);

            if (!moderationResult) {
                logger.error("[BrainstormService] Moderation failed");
                return null;
            }

            const selectedAgentPubkeys = moderationResult.selectedAgents;
            const chosenIndices: number[] = [];

            // Find indices for all selected agents
            for (const pubkey of selectedAgentPubkeys) {
                const index = responses.findIndex(r => r.agent.pubkey === pubkey);
                if (index !== -1) {
                    chosenIndices.push(index);
                } else {
                    logger.warn("[BrainstormService] Selected agent not found in responses", { pubkey });
                }
            }

            if (chosenIndices.length === 0) {
                logger.error("[BrainstormService] No valid selections found");
                return null;
            }

            const choice = {
                chosenIndices,
                reason: moderationResult.reasoning || "No specific reason provided"
            };

            logger.info("[BrainstormService] Moderation complete", {
                selectedCount: chosenIndices.length,
                chosenAgents: chosenIndices.map(i => responses[i].agent.name),
                reason: choice.reason
            });

            return choice;
        } catch (error) {
            logger.error("[BrainstormService] Moderation failed", {
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }

    /**
     * Publish moderator's selection as a kind:7 event
     */
    private async publishModeratorSelection(
        brainstormRoot: NDKEvent,
        chosenResponse: BrainstormResponse,
        moderator: AgentInstance,
        conversationId: string,
        reason: string
    ): Promise<void> {
        try {
            // We already have the response event directly from the executor
            await this.publishSelection(
                brainstormRoot,
                chosenResponse.event,
                chosenResponse.agent,
                moderator,
                conversationId,
                reason
            );
        } catch (error) {
            logger.error("[BrainstormService] Failed to publish selection", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Create and publish a kind:7 selection event
     */
    private async publishSelection(
        brainstormRoot: NDKEvent,
        selectedResponse: NDKEvent,
        selectedAgent: AgentInstance,
        moderator: AgentInstance,
        conversationId: string,
        reason?: string
    ): Promise<void> {
        const ndk = getNDK();
        const selectionEvent = new NDKEvent(ndk);
        
        // Build selection event
        selectionEvent.kind = NostrKind.REACTION;
        selectionEvent.content = TagValue.REACTION_POSITIVE;
        selectionEvent.pubkey = moderator.pubkey;
        
        selectionEvent.tags = [
            [NostrTag.ROOT_EVENT, brainstormRoot.id],
            [NostrTag.EVENT, selectedResponse.id],
            [NostrTag.PUBKEY, selectedAgent.pubkey],
        ];
        
        // Add optional tags
        const aTag = brainstormRoot.tagValue(NostrTag.REPLACEABLE);
        if (aTag) {
            selectionEvent.tags.push([NostrTag.REPLACEABLE, aTag]);
        }
        
        selectionEvent.tags.push([NostrTag.BRAINSTORM_SELECTION]);
        
        if (reason) {
            selectionEvent.tags.push([NostrTag.REASON, reason.substring(0, MAX_REASON_LENGTH)]);
        }
        
        // Sign and publish
        await moderator.sign(selectionEvent);
        await selectionEvent.publish();
        
        logger.debug("[BrainstormService] Published selection event", {
            selectionId: selectionEvent.id?.substring(0, 8)
        });
    }

    /**
     * Handle follow-up responses to brainstorm events
     */
    async handleFollowUp(event: NDKEvent): Promise<void> {
        try {
            logger.info("[BrainstormService] Handling brainstorm follow-up", {
                eventId: event.id?.substring(0, 8)
            });

            const isFromParticipant = this.projectContext.getAgentByPubkey(event.pubkey) !== undefined;

            if (!isFromParticipant) {
                // User follow-up - start new brainstorm round
                await this.startFollowUpBrainstorm(event);
            } else {
                // Agent follow-up - evaluate if valuable
                await this.handleAgentFollowUp(event);
            }
        } catch (error) {
            logger.error("[BrainstormService] Failed to handle follow-up", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Handle agent follow-up to evaluate if valuable
     */
    private async handleAgentFollowUp(event: NDKEvent): Promise<void> {
        const coordinator = await this.getConversationCoordinator();
        const resolver = new ConversationResolver(coordinator);
        const { conversation } = await resolver.resolveConversationForEvent(event);
        
        if (!conversation) {
            logger.error("[BrainstormService] Could not resolve conversation for follow-up");
            return;
        }

        const rootEvent = conversation.history[0];
        if (!rootEvent || !this.isBrainstormEvent(rootEvent)) {
            logger.error("[BrainstormService] Root event is not a brainstorm event");
            return;
        }

        // Find winning response
        const winningResponse = conversation.history.find(e =>
            e.tagValue(NostrTag.EVENT) === rootEvent.id && 
            !e.tagValue(NostrTag.NOT_CHOSEN) &&
            e.kind === NostrKind.GENERIC_REPLY
        );

        if (!winningResponse) {
            logger.error("[BrainstormService] Could not find winning response in brainstorm");
            return;
        }

        // Evaluate follow-up value
        const moderatorPubkey = AgentEventDecoder.getModerator(rootEvent);
        if (!moderatorPubkey) return;

        const moderator = this.projectContext.getAgentByPubkey(moderatorPubkey);
        if (!moderator) return;

        const isValuable = await this.evaluateFollowUpValue(
            rootEvent.content || "",
            winningResponse.content || "",
            event.content || "",
            moderator
        );

        if (isValuable) {
            logger.info("[BrainstormService] Follow-up deemed valuable");
            // Follow-up will be published normally by the agent
        } else {
            logger.debug("[BrainstormService] Follow-up not valuable, ignoring");
        }
    }

    /**
     * Evaluate if a follow-up adds value
     */
    private async evaluateFollowUpValue(
        originalPrompt: string,
        winningResponse: string,
        followUp: string,
        moderator: AgentInstance
    ): Promise<boolean> {
        try {
            const prompt = this.buildFollowUpModerationPrompt(
                originalPrompt,
                winningResponse,
                followUp
            );

            const llmService = moderator.createLLMService();

            const result = await llmService.complete([
                {
                    role: "system",
                    content: "You are evaluating if a follow-up comment adds value to a brainstorm discussion. Respond ONLY with valid JSON: {\"is_valuable\": true/false, \"reason\": \"<explanation>\"}"
                },
                {
                    role: "user",
                    content: prompt
                }
            ], {});

            const parsed = safeParseJSON<{ is_valuable: boolean; reason: string }>(
                result.text,
                "follow-up evaluation"
            );

            return parsed?.is_valuable === true;
        } catch (error) {
            logger.error("[BrainstormService] Failed to evaluate follow-up", {
                error: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    }

    /**
     * Start a follow-up brainstorm from user input
     */
    private async startFollowUpBrainstorm(event: NDKEvent): Promise<void> {
        logger.info("[BrainstormService] Starting follow-up brainstorm from user input");

        // Get participants from event
        const participantPubkeys = AgentEventDecoder.getParticipants(event);
        const participants = this.resolveParticipants(participantPubkeys);

        if (participants.length === 0) {
            logger.error("[BrainstormService] No valid participants for follow-up");
            return;
        }

        // Resolve conversation
        const coordinator = await this.getConversationCoordinator();
        const resolver = new ConversationResolver(coordinator);
        const { conversation } = await resolver.resolveConversationForEvent(event);

        if (!conversation) {
            logger.error("[BrainstormService] Could not resolve conversation");
            return;
        }

        // Execute participants
        const responses = await this.executeParticipants(
            participants,
            event,
            conversation
        );

        if (responses.length === 0) {
            logger.error("[BrainstormService] No follow-up responses collected");
            return;
        }

        // Get moderator from root event
        const rootEvent = conversation.history[0];
        const moderatorPubkey = AgentEventDecoder.getModerator(rootEvent);
        if (!moderatorPubkey) return;

        const moderator = this.projectContext.getAgentByPubkey(moderatorPubkey);
        if (!moderator) return;

        // Run moderation
        const moderationResult = await this.runModeration(
            moderator,
            event.content || "",
            responses,
            rootEvent,  // Use the original brainstorm root event
            conversation
        );

        if (!moderationResult) return;

        // Publish selection
        // Publish selection events for all chosen responses
        for (const index of moderationResult.chosenIndices) {
            await this.publishModeratorSelection(
                rootEvent, // Use original brainstorm root
                responses[index],
                moderator,
                conversation.id,
                moderationResult.reason
            );
        }

        logger.info("[BrainstormService] Follow-up brainstorm completed");
    }

    /**
     * Checks if an event is a brainstorm event using the shared helper
     */
    private isBrainstormEvent(event: NDKEvent): boolean {
        return isBrainstormEvent(event.kind, event.tags);
    }

    /**
     * Build moderation prompt for choosing best response
     */
    private buildModerationPrompt(originalPrompt: string, responses: BrainstormResponse[]): string {
        let prompt = `Original question/prompt:\n${originalPrompt}\n\n`;
        prompt += `You have ${responses.length} responses to choose from:\n\n`;
        
        for (const [i, response] of responses.entries()) {
            prompt += `Option ${i + 1} (from ${response.agent.name}):\n`;
            prompt += `${response.content}\n\n`;
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
               "Evaluate if this follow-up adds significant value, provides important corrections, " +
               "or contributes meaningful insights to the discussion. " +
               "Be selective - only approve truly valuable additions.";
    }

}