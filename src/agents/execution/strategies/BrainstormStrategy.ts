import type { MessageGenerationStrategy } from "./types";
import type { ExecutionContext } from "../types";
import type { ModelMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import { NostrKind, NostrTag, TagValue, isBrainstormEvent } from "@/nostr/constants";
import { isEventFromUser } from "@/nostr/utils";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";

/**
 * Message generation strategy for brainstorming sessions.
 * Only includes agent responses that have been selected via kind:7 events.
 */
export class BrainstormStrategy implements MessageGenerationStrategy {
    
    /**
     * Build messages for brainstorm context, including only selected responses
     */
    async buildMessages(
        context: ExecutionContext,
        triggeringEvent: NDKEvent,
        eventFilter?: (event: NDKEvent) => boolean
    ): Promise<ModelMessage[]> {
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);
        
        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }
        
        const messages: ModelMessage[] = [];

        // Add system prompt
        await this.addSystemPrompt(messages, context);

        // Apply event filter if provided
        let history = conversation.history;
        if (eventFilter) {
            const originalLength = history.length;
            history = history.filter(eventFilter);
            logger.info("[BrainstormStrategy] Applied event filter to conversation history", {
                originalLength,
                filteredLength: history.length,
                eventsRemoved: originalLength - history.length
            });
        }

        // Process brainstorm rounds
        const brainstormRoots = this.findBrainstormRoots(history);
        
        for (const root of brainstormRoots) {
            await this.processBrainstormRound(
                root,
                history,
                messages,
                context.agent.pubkey
            );
        }
        
        // Process triggering event if not already included
        await this.processTriggeringEventIfNeeded(
            triggeringEvent,
            brainstormRoots,
            conversation.history,
            messages,
            context.agent.pubkey
        );
        
        logger.debug("[BrainstormStrategy] Message building complete", {
            totalMessages: messages.length,
            brainstormRounds: brainstormRoots.length
        });
        
        return messages;
    }
    
    /**
     * Adds system prompt messages to the conversation context
     */
    private async addSystemPrompt(
        messages: ModelMessage[],
        context: ExecutionContext
    ): Promise<void> {
        if (!isProjectContextInitialized()) {
            // In production, system prompt is required
            if (process.env.NODE_ENV === 'production') {
                throw new Error("[BrainstormStrategy] Project context required for system prompt");
            }
            // In tests, skip gracefully
            logger.debug("[BrainstormStrategy] Project context not initialized, skipping system prompt");
            return;
        }
        
        const projectCtx = getProjectContext();
        const project = projectCtx.project;

        // Get conversation from context
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);

        // Build system prompt messages
        const systemMessages = buildSystemPromptMessages({
            agent: context.agent,
            project,
            availableAgents: Array.from(projectCtx.agents.values()),
            conversation,
            agentLessons: new Map(),
            isProjectManager: context.agent.pubkey === projectCtx.getProjectManager().pubkey,
            projectManagerPubkey: projectCtx.getProjectManager().pubkey
        });

        // Add all system messages
        for (const systemMsg of systemMessages) {
            messages.push(systemMsg.message);
        }
    }
    
    /**
     * Finds all brainstorm root events (kind:11 with mode:brainstorm) in conversation history
     */
    private findBrainstormRoots(history: NDKEvent[]): NDKEvent[] {
        return history.filter(e => isBrainstormEvent(e.kind, e.tags));
    }
    
    /**
     * Processes a complete brainstorm round including root, responses, and follow-ups
     */
    private async processBrainstormRound(
        root: NDKEvent,
        history: NDKEvent[],
        messages: ModelMessage[],
        agentPubkey: string
    ): Promise<void> {
        // Add root prompt
        await this.addRootPrompt(root, messages, agentPubkey);
        
        // Add selected responses
        await this.addSelectedResponses(root.id, history, messages, agentPubkey);
        
        // Add follow-ups
        await this.addFollowUps(root.id, history, messages, agentPubkey);
    }

    /**
     * Adds the brainstorm root prompt to messages
     */
    private async addRootPrompt(
        root: NDKEvent,
        messages: ModelMessage[],
        agentPubkey: string
    ): Promise<void> {
        const rootMessages = await this.processEvent(root, agentPubkey);
        messages.push(...rootMessages);
    }

    /**
     * Adds only the selected responses to messages based on kind:7 reactions
     */
    private async addSelectedResponses(
        rootId: string,
        history: NDKEvent[],
        messages: ModelMessage[],
        agentPubkey: string
    ): Promise<void> {
        const responses = this.findResponses(history, rootId);
        const selectedIds = this.getSelectedResponseIds(history, rootId);
        
        logger.debug("[BrainstormStrategy] Processing selected responses", {
            rootId: rootId?.substring(0, 8),
            responseCount: responses.length,
            selectedCount: selectedIds.size
        });
        
        for (const response of responses) {
            if (selectedIds.has(response.id)) {
                const responseMessages = await this.processEvent(response, agentPubkey);
                messages.push(...responseMessages);
            }
        }
    }

    /**
     * Adds follow-up events that are neither responses nor reactions
     */
    private async addFollowUps(
        rootId: string,
        history: NDKEvent[],
        messages: ModelMessage[],
        agentPubkey: string
    ): Promise<void> {
        await this.processFollowUps(rootId, history, messages, agentPubkey);
    }
    
    /**
     * Finds all generic reply events (kind:1111) that reference the given root event
     */
    private findResponses(history: NDKEvent[], rootId: string): NDKEvent[] {
        return history.filter(e =>
            e.kind === NostrKind.GENERIC_REPLY && 
            e.tagValue(NostrTag.ROOT_EVENT) === rootId
        );
    }
    
    /**
     * Extracts IDs of responses that have been positively selected via kind:7 reactions
     */
    private getSelectedResponseIds(history: NDKEvent[], rootId: string): Set<string> {
        const selections = history.filter(e =>
            e.kind === NostrKind.REACTION &&
            e.content === TagValue.REACTION_POSITIVE &&
            e.tagValue(NostrTag.ROOT_EVENT) === rootId
        );
        
        const selectedIds = new Set<string>();
        for (const selection of selections) {
            const selectedId = selection.tagValue(NostrTag.EVENT);
            if (selectedId) {
                selectedIds.add(selectedId);
            }
        }
        
        return selectedIds;
    }
    
    /**
     * Processes follow-up events that are neither responses nor reactions to include in context
     */
    private async processFollowUps(
        rootId: string,
        history: NDKEvent[],
        messages: ModelMessage[],
        agentPubkey: string
    ): Promise<void> {
        const followUps = history.filter(e =>
            e.tagValue(NostrTag.EVENT) === rootId &&
            e.kind !== NostrKind.GENERIC_REPLY &&
            e.kind !== NostrKind.REACTION &&
            e.id !== rootId
        );
        
        for (const followUp of followUps) {
            const followUpMessages = await this.processEvent(followUp, agentPubkey);
            messages.push(...followUpMessages);
        }
    }
    
    /**
     * Processes the triggering event if it hasn't been already included in the messages
     */
    private async processTriggeringEventIfNeeded(
        triggeringEvent: NDKEvent,
        brainstormRoots: NDKEvent[],
        history: NDKEvent[],
        messages: ModelMessage[],
        agentPubkey: string
    ): Promise<void> {
        if (!this.isEventAlreadyProcessed(triggeringEvent, brainstormRoots, history)) {
            logger.debug("[BrainstormStrategy] Processing triggering event", {
                eventId: triggeringEvent.id?.substring(0, 8),
                kind: triggeringEvent.kind
            });
            
            const triggerMessages = await this.processEvent(triggeringEvent, agentPubkey);
            messages.push(...triggerMessages);
        }
    }
    
    /**
     * Checks if an event has already been processed in the current context
     */
    private isEventAlreadyProcessed(
        event: NDKEvent,
        brainstormRoots: NDKEvent[],
        history: NDKEvent[]
    ): boolean {
        // Check if it's a brainstorm root
        if (brainstormRoots.some(r => r.id === event.id)) {
            return true;
        }
        
        // Check if it's a response or reaction that would have been processed
        return history.some(e => 
            e.id === event.id && 
            (e.kind === NostrKind.GENERIC_REPLY || e.kind === NostrKind.REACTION)
        );
    }
    
    /**
     * Transforms a Nostr event into LLM-compatible model messages.
     * In brainstorm context, messages include speaker identification without targeting notation.
     */
    private async processEvent(
        event: NDKEvent,
        agentPubkey: string
    ): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];

        // Check for phase transitions (if used in brainstorms)
        const phaseTag = event.tagValue(NostrTag.PHASE);
        const phaseInstructionsTag = event.tagValue(NostrTag.PHASE_INSTRUCTIONS);

        if (phaseTag) {
            const phaseContent = PromptBuilder.buildFragment("phase-transition", {
                phase: phaseTag,
                phaseInstructions: phaseInstructionsTag
            });

            if (phaseContent) {
                messages.push({ role: "system", content: phaseContent });
                logger.debug("[BrainstormStrategy] Added phase transition", {
                    eventId: event.id?.substring(0, 8),
                    phase: phaseTag
                });
            }
        }

        // Format main content with speaker identification
        const content = event.content || "";

        if (event.pubkey === agentPubkey) {
            // Agent's own message
            messages.push({ role: "assistant", content });
        } else if (isEventFromUser(event)) {
            // User message - always format as simple "user" role in brainstorms
            messages.push({ role: "user", content });
        } else {
            // Another agent's message - include agent name for differentiation
            const agentName = await this.getAgentName(event.pubkey);
            const formattedContent = agentName ? `[${agentName}]: ${content}` : content;
            messages.push({ role: "system", content: formattedContent });
        }

        return messages;
    }

    /**
     * Gets the agent name from their public key using the project context
     */
    private async getAgentName(pubkey: string): Promise<string | undefined> {
        if (!isProjectContextInitialized()) {
            return undefined;
        }

        const projectCtx = getProjectContext();
        const agent = projectCtx.agents.get(pubkey);
        return agent?.name;
    }
}