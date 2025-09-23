import type { AgentInstance } from "@/agents/types";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { ExecutionContext } from "@/agents/execution/types";
import { BrainstormStrategy } from "@/agents/execution/strategies/BrainstormStrategy";
import { ConversationCoordinator } from "@/conversations";
import type { Conversation } from "@/conversations/types";
import { ConversationResolver } from "@/conversations/services/ConversationResolver";
import { configService } from "@/services/ConfigService";
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
}

interface ModerationResult {
    chosen_option: number;
    reason: string;
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
            responses
        );

        if (!moderationResult) return;

        // Publish final selection
        await this.publishModeratorSelection(
            event,
            responses[moderationResult.chosenIndex],
            moderator,
            conversation.id,
            moderationResult.reason
        );
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
        
        // Execute all participants in parallel
        const results = await Promise.allSettled(
            participants.map(participant => 
                this.executeParticipant(participant, event, conversation, coordinator)
            )
        );

        // Extract successful participants and log failures
        const successfulAgents = this.extractSuccessfulParticipants(results, participants);

        if (successfulAgents.length === 0) return [];

        // Fetch response events
        return await this.fetchResponseEvents(
            successfulAgents,
            event.id,
            conversation.id,
            coordinator
        );
    }

    /**
     * Extracts successful participants from execution results and logs failures
     */
    private extractSuccessfulParticipants(
        results: PromiseSettledResult<AgentInstance>[],
        participants: AgentInstance[]
    ): AgentInstance[] {
        const successful: AgentInstance[] = [];
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                successful.push(result.value);
            } else if (result.status === 'rejected') {
                logger.error("[BrainstormService] Participant execution failed", {
                    participant: participants[index].name,
                    error: result.reason
                });
            }
        });
        
        return successful;
    }

    /**
     * Executes a single participant agent and returns it on success
     */
    private async executeParticipant(
        participant: AgentInstance,
        event: NDKEvent,
        conversation: Conversation,
        coordinator: ConversationCoordinator
    ): Promise<AgentInstance> {
        logger.debug("[BrainstormService] Executing participant", {
            name: participant.name
        });

        const context: ExecutionContext = {
            agent: participant,
            conversationId: conversation.id,
            projectPath: this.projectContext.agentRegistry.getBasePath(),
            triggeringEvent: event,
            conversationCoordinator: coordinator,
        };

        const strategy = new BrainstormStrategy();
        const executor = new AgentExecutor(strategy);
        await executor.execute(context);
        
        return participant;
    }

    /**
     * Fetches the actual response events published by participants from conversation history
     */
    private async fetchResponseEvents(
        agents: AgentInstance[],
        rootEventId: string,
        conversationId: string,
        coordinator: ConversationCoordinator
    ): Promise<BrainstormResponse[]> {
        // Get the conversation directly - no refresh method exists
        const conversation = coordinator.getConversation(conversationId);
        
        if (!conversation) {
            logger.error("[BrainstormService] Conversation not found", { conversationId });
            return [];
        }

        const responses: BrainstormResponse[] = [];
        
        for (const agent of agents) {
            const responseEvent = conversation.history.find(e => 
                e.kind === NostrKind.GENERIC_REPLY && 
                e.tagValue(NostrTag.ROOT_EVENT) === rootEventId &&
                e.pubkey === agent.pubkey
            );
            
            if (responseEvent?.content) {
                responses.push({
                    agent,
                    content: responseEvent.content
                });
            } else {
                logger.debug("[BrainstormService] No response found for agent", {
                    agent: agent.name
                });
            }
        }
        
        return responses;
    }

    /**
     * Runs the moderation process to select the best response from participants
     */
    private async runModeration(
        moderator: AgentInstance,
        originalPrompt: string,
        responses: BrainstormResponse[]
    ): Promise<{ chosenIndex: number; reason: string } | null> {
        try {
            logger.debug("[BrainstormService] Running moderation", {
                moderator: moderator.name,
                responseCount: responses.length
            });

            const prompt = this.buildModerationPrompt(originalPrompt, responses);
            
            const llmLogger = this.projectContext.llmLogger.withAgent(moderator.name);
            const llmService = configService.createLLMService(
                llmLogger,
                moderator.llmConfig
            );

            const result = await llmService.complete([
                {
                    role: "system",
                    content: "You are a moderator choosing the best response. Respond ONLY with valid JSON in the format: {\"chosen_option\": <number>, \"reason\": \"<explanation>\"}"
                },
                {
                    role: "user",
                    content: prompt
                }
            ], {});

            const parsed = safeParseJSON<ModerationResult>(
                result.text,
                "moderation result"
            );

            if (!parsed) {
                logger.warn("[BrainstormService] Failed to parse moderation result", {
                    rawOutput: result.text.substring(0, 200)
                });
                throw new Error("Moderation failed: Invalid JSON response from moderator");
            }

            const chosenIndex = parsed.chosen_option - 1; // Convert to 0-based
            
            // Validate index
            if (chosenIndex < 0 || chosenIndex >= responses.length) {
                logger.warn("[BrainstormService] Invalid chosen index from moderator", {
                    chosenIndex,
                    responseCount: responses.length,
                    rawOption: parsed.chosen_option
                });
                throw new Error(`Invalid moderation choice: ${parsed.chosen_option} out of ${responses.length} options`);
            }

            logger.info("[BrainstormService] Moderation complete", {
                chosenAgent: responses[chosenIndex].agent.name
            });

            return { 
                chosenIndex, 
                reason: parsed.reason || "No reason provided" 
            };
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
            // Find the actual response event
            const coordinator = await this.getConversationCoordinator();
            const conversation = coordinator.getConversation(conversationId);
            
            if (!conversation) {
                logger.error("[BrainstormService] Conversation not found for selection");
                return;
            }

            const responseEvent = conversation.history.find(e => 
                e.kind === NostrKind.GENERIC_REPLY && 
                e.tagValue(NostrTag.ROOT_EVENT) === brainstormRoot.id &&
                e.pubkey === chosenResponse.agent.pubkey
            );

            if (!responseEvent) {
                logger.error("[BrainstormService] Response event not found for selection");
                return;
            }

            await this.publishSelection(
                brainstormRoot,
                responseEvent,
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

            const llmLogger = this.projectContext.llmLogger.withAgent(moderator.name);
            const llmService = configService.createLLMService(
                llmLogger,
                moderator.llmConfig
            );

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
            responses
        );

        if (!moderationResult) return;

        // Publish selection
        await this.publishModeratorSelection(
            rootEvent, // Use original brainstorm root
            responses[moderationResult.chosenIndex],
            moderator,
            conversation.id,
            moderationResult.reason
        );

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
        
        responses.forEach((response, i) => {
            prompt += `Option ${i + 1} (from ${response.agent.name}):\n`;
            prompt += `${response.content}\n\n`;
        });
        
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