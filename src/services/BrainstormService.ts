import type { AgentInstance } from "@/agents/types";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { ExecutionContext } from "@/agents/execution/types";
import { BrainstormStrategy } from "@/agents/execution/strategies/BrainstormStrategy";
import { ThreadWithMemoryStrategy } from "@/agents/execution/strategies/ThreadWithMemoryStrategy";
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
import { generateObject } from "ai";
import { z } from "zod";

interface BrainstormResponse {
    agent: AgentInstance;
    content: string;
    event: NDKEvent;
}

interface ModerationResult {
    chosen_option: number;
    reason: string;
}

const ModerationResultSchema = z.object({
    chosenOptionIndex: z.number().min(0).describe("Zero-based index of the chosen response option"),
    reason: z.string().min(10).max(500).describe("Clear explanation of why this option was selected, focusing on accuracy, completeness, clarity, and relevance"),
    confidence: z.number().min(0).max(1).describe("Confidence level in this choice (0.0 to 1.0)"),
    strengths: z.array(z.string()).describe("Key strengths of the chosen response"),
    weaknesses: z.array(z.string()).optional().describe("Minor weaknesses or areas for improvement in the chosen response")
});

type StructuredModerationResult = z.infer<typeof ModerationResultSchema>;

const FollowUpEvaluationSchema = z.object({
    isValuable: z.boolean().describe("Whether the follow-up adds significant value to the discussion"),
    reason: z.string().min(10).max(300).describe("Clear explanation of why the follow-up is or isn't valuable"),
    valueType: z.enum(["correction", "enhancement", "clarification", "new_insight", "none"]).describe("Type of value added"),
    confidence: z.number().min(0).max(1).describe("Confidence level in this evaluation (0.0 to 1.0)")
});

type FollowUpEvaluation = z.infer<typeof FollowUpEvaluationSchema>;

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

        // Execute all participants in parallel and get their responses directly
        const results = await Promise.allSettled(
            participants.map(participant =>
                this.executeParticipant(participant, event, conversation, coordinator)
            )
        );

        // Extract successful responses and log failures
        const responses: BrainstormResponse[] = [];
        results.forEach((result, index) => {
            console.log('response received', result);
            if (result.status === 'fulfilled' && result.value) {
                responses.push(result.value);
            } else if (result.status === 'rejected') {
                logger.error("[BrainstormService] Participant execution failed", {
                    participant: participants[index].name,
                    error: result.reason
                });
            } else {
                logger.debug("[BrainstormService] Participant produced no response", {
                    participant: participants[index].name
                });
            }
        });

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
        };

        const strategy = new BrainstormStrategy();
        const executor = new AgentExecutor(strategy);
        const responseEvent = await executor.execute(context);

        logger.debug("[BrainstormService] Participant execution result", {
            agent: participant.name,
            hasEvent: !!responseEvent,
            eventContent: responseEvent?.content,
            eventId: responseEvent?.id
        });

        if (responseEvent && responseEvent.content) {
            return {
                agent: participant,
                content: responseEvent.content,
                event: responseEvent
            };
        }

        return null;
    }

    /**
     * Runs the moderation process to select the best response from participants using structured AI generation
     */
    private async runModeration(
        moderator: AgentInstance,
        originalPrompt: string,
        responses: BrainstormResponse[],
        brainstormRoot: NDKEvent,
        conversation: Conversation
    ): Promise<{ chosenIndex: number; reason: string } | null> {
        try {
            logger.debug("[BrainstormService] Running structured moderation", {
                moderator: moderator.name,
                responseCount: responses.length
            });

            const llmLogger = this.projectContext.llmLogger.withAgent(moderator.name);
            const llmService = configService.createLLMService(
                llmLogger,
                moderator.llmConfig
            );

            // Build structured prompt for evaluation
            const evaluationPrompt = this.buildStructuredModerationPrompt(originalPrompt, responses);

            // Use generateObject for structured moderation
            const result = await generateObject({
                model: llmService.getModel(),
                schema: ModerationResultSchema,
                prompt: evaluationPrompt,
            });

            const moderationResult = result.object;

            // Validate the chosen index is within bounds
            if (moderationResult.chosenOptionIndex < 0 || moderationResult.chosenOptionIndex >= responses.length) {
                logger.error("[BrainstormService] Invalid choice index from moderator", {
                    chosenIndex: moderationResult.chosenOptionIndex,
                    responseCount: responses.length
                });
                return null;
            }

            logger.info("[BrainstormService] Structured moderation complete", {
                chosenAgent: responses[moderationResult.chosenOptionIndex].agent.name,
                reason: moderationResult.reason,
                confidence: moderationResult.confidence,
                strengths: moderationResult.strengths
            });

            return {
                chosenIndex: moderationResult.chosenOptionIndex,
                reason: moderationResult.reason
            };
        } catch (error) {
            logger.error("[BrainstormService] Structured moderation failed", {
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
     * Evaluate if a follow-up adds value using structured AI generation
     */
    private async evaluateFollowUpValue(
        originalPrompt: string,
        winningResponse: string,
        followUp: string,
        moderator: AgentInstance
    ): Promise<boolean> {
        try {
            const llmLogger = this.projectContext.llmLogger.withAgent(moderator.name);
            const llmService = configService.createLLMService(
                llmLogger,
                moderator.llmConfig
            );

            const evaluationPrompt = this.buildStructuredFollowUpPrompt(
                originalPrompt,
                winningResponse,
                followUp
            );

            const result = await generateObject({
                model: llmService.getModel(),
                schema: FollowUpEvaluationSchema,
                prompt: evaluationPrompt,
            });

            const evaluation = result.object;

            logger.debug("[BrainstormService] Follow-up evaluation result", {
                isValuable: evaluation.isValuable,
                valueType: evaluation.valueType,
                confidence: evaluation.confidence,
                reason: evaluation.reason
            });

            return evaluation.isValuable;
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
     * Build structured moderation prompt for AI SDK generateObject
     */
    private buildStructuredModerationPrompt(originalPrompt: string, responses: BrainstormResponse[]): string {
        let prompt = `You are a moderator evaluating responses to select the best one. Here is the context:

ORIGINAL REQUEST:
${originalPrompt}

RESPONSES TO EVALUATE (${responses.length} options):
`;

        responses.forEach((response, i) => {
            prompt += `
OPTION ${i} (from agent: ${response.agent.name}):
${response.content}
---
`;
        });

        prompt += `
EVALUATION CRITERIA:
- Accuracy: How correct and factual is the response?
- Completeness: Does it fully address the request?
- Clarity: Is it well-written and easy to understand?
- Relevance: How well does it match what was asked?
- Practical value: How useful is the response?

Your task is to select the single best response by providing:
1. The zero-based index of your chosen option (0 for the first option, 1 for the second, etc.)
2. A clear reason explaining your choice
3. Your confidence level (0.0 to 1.0)
4. Key strengths of the chosen response
5. Optional: Minor weaknesses or areas for improvement

Be objective and thorough in your evaluation.`;

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

    /**
     * Build structured follow-up evaluation prompt for AI SDK generateObject
     */
    private buildStructuredFollowUpPrompt(
        originalPrompt: string,
        winningResponse: string,
        followUp: string
    ): string {
        return `You are evaluating whether a follow-up comment adds significant value to a brainstorm discussion.

ORIGINAL BRAINSTORM REQUEST:
${originalPrompt}

WINNING RESPONSE (already selected):
${winningResponse}

FOLLOW-UP COMMENT TO EVALUATE:
${followUp}

EVALUATION CRITERIA:
Your task is to determine if this follow-up comment adds significant value by providing:
- Important corrections to the winning response
- Meaningful enhancements or additional insights
- Critical clarifications that improve understanding
- New perspectives that weren't covered

VALUE TYPES:
- correction: Fixes errors or inaccuracies in the winning response
- enhancement: Adds useful details or improvements
- clarification: Makes something clearer or easier to understand
- new_insight: Provides a fresh perspective or approach
- none: Doesn't add meaningful value

Be selective and objective. Only approve follow-ups that genuinely improve the discussion. Redundant, obvious, or low-value comments should be marked as not valuable.`;
    }


}