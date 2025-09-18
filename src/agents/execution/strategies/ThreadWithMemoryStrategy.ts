import type { MessageGenerationStrategy } from "./types";
import type { ExecutionContext } from "../types";
import type { ModelMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { NostrEntityProcessor } from "@/conversations/processors/NostrEntityProcessor";
import { EventToModelMessage } from "@/conversations/processors/EventToModelMessage";
import {
    buildSystemPromptMessages
} from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { isDebugMode } from "@/prompts/fragments/debug-mode";
import { isVoiceMode } from "@/prompts/fragments/20-voice-mode";
import { getPubkeyNameRepository } from "@/services/PubkeyNameRepository";
import { getNDK } from "@/nostr";
import chalk from "chalk";
import { ThreadedConversationFormatter, ThreadNode, FormatterOptions } from "@/conversations/formatters/ThreadedConversationFormatter";

/**
 * Message generation strategy that includes thread context and agent memory
 * This strategy ensures agents remember their prior participations across threads
 */
export class ThreadWithMemoryStrategy implements MessageGenerationStrategy {

    /**
     * Build messages with thread context and agent memory
     */
    async buildMessages(
        context: ExecutionContext,
        triggeringEvent: NDKEvent
    ): Promise<ModelMessage[]> {
        const { threadService } = context.conversationCoordinator;
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);

        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        const messages: ModelMessage[] = [];

        // Add system prompt
        await this.addSystemPrompt(messages, context);

        // 1. Get current thread (from root to triggering event)
        logger.info("[ThreadWithMemoryStrategy] Getting thread for triggering event", {
            triggeringEventId: triggeringEvent.id.substring(0, 8),
            triggeringContent: triggeringEvent.content?.substring(0, 50),
            triggeringParent: triggeringEvent.tagValue("e")?.substring(0, 8),
            historySize: conversation.history.length
        });

        const currentThread = threadService.getThreadToEvent(
            triggeringEvent.id,
            conversation.history
        );

        logger.info("[ThreadWithMemoryStrategy] Current thread retrieved", {
            conversationId: context.conversationId.substring(0, 8),
            agentName: context.agent.name,
            currentThreadLength: currentThread.length,
            triggeringEventId: triggeringEvent.id.substring(0, 8),
            threadEvents: currentThread.slice(0, 5).map(e => ({
                id: e.id.substring(0, 8),
                content: e.content?.substring(0, 30),
                pubkey: e.pubkey?.substring(0, 8)
            }))
        });

        // 2. Create a Set of event IDs from the active branch
        const activeBranchIds = new Set<string>(currentThread.map(e => e.id));
        
        logger.info("[ThreadWithMemoryStrategy] Active branch identified", {
            activeBranchSize: activeBranchIds.size,
            activeBranchIds: Array.from(activeBranchIds).slice(0, 5).map(id => id.substring(0, 8))
        });

        // 3. Get ALL events in the conversation and format other branches
        const allEvents = conversation.history;
        const formatter = new ThreadedConversationFormatter();
        const otherBranchesFormatted = formatter.formatOtherBranches(
            allEvents,
            context.agent.pubkey,
            activeBranchIds
        );

        if (otherBranchesFormatted) {
            // Enhance with agent names
            const enhancedContent = await this.enhanceFormattedContent(
                otherBranchesFormatted,
                context.agent.pubkey,
                context.agent.name
            );
            
            messages.push({
                role: "system",
                content: `You were active in these other related subthreads in this conversation:\n\n${enhancedContent}`
            });

            logger.info("[ThreadWithMemoryStrategy] Added agent memory from other branches", {
                agentName: context.agent.name
            });

            // 4. Add current thread context (FULL thread from root to current)
            messages.push({
                role: "system",
                content: "Current thread you are responding to:"
            });
        } else {
            logger.info("[ThreadWithMemoryStrategy] No other branches with agent participation", {
                agentName: context.agent.name,
            });
        }


        logger.info("[ThreadWithMemoryStrategy] Adding current thread events", {
            threadLength: currentThread.length,
            firstEvent: currentThread[0] ? {
                id: currentThread[0].id.substring(0, 8),
                content: currentThread[0].content?.substring(0, 30)
            } : null,
            lastEvent: currentThread[currentThread.length - 1] ? {
                id: currentThread[currentThread.length - 1].id.substring(0, 8),
                content: currentThread[currentThread.length - 1].content?.substring(0, 30)
            } : null
        });

        // Process and add ALL events in current thread
        for (let i = 0; i < currentThread.length; i++) {
            const event = currentThread[i];
            const isTriggeringEvent = event.id === triggeringEvent.id;

            // Add a clear marker before the triggering event
            if (isTriggeringEvent && !event.pubkey.includes(context.agent.pubkey)) {
                messages.push({
                    role: "system",
                    content: "═══ IMPORTANT: THE FOLLOWING IS THE MESSAGE TO RESPOND TO. ═══"
                });
                logger.info("[ThreadWithMemoryStrategy] Added triggering event marker", {
                    eventId: event.id.substring(0, 8)
                });
            }

            const processedMessages = await this.processEvent(
                event,
                context.agent.pubkey,
                context.conversationId,
            );
            messages.push(...processedMessages);

            logger.debug("[ThreadWithMemoryStrategy] Added event to messages", {
                eventId: event.id.substring(0, 8),
                eventContent: event.content?.substring(0, 30),
                messageCount: processedMessages.length,
                isAgent: event.pubkey === context.agent.pubkey,
                isTriggeringEvent
            });
        }

        // Add special context instructions if needed
        await this.addSpecialContext(messages, context, triggeringEvent);

        logger.info("[ThreadWithMemoryStrategy] Message building complete", {
            totalMessages: messages.length,
            hasMemoryFromOtherThreads: otherBranchesFormatted !== null,
            currentThreadLength: currentThread.length
        });

        return messages;
    }

    /**
     * Enhance formatted content with agent names
     */
    private async enhanceFormattedContent(
        formattedContent: string,
        agentPubkey: string,
        agentName: string
    ): Promise<string> {
        // This is a simplified version - in the future we could parse
        // the formatted content and replace pubkeys with names
        // For now, just return the formatted content as-is
        return formattedContent;
    }

    /**
     * Process a single event into messages
     */
    private async processEvent(event: NDKEvent, agentPubkey: string, conversationId: string): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];

        // Skip reasoning events - they should not be included in context
        const isReasoningEvent = event.tags.some(t => t[0] === 'reasoning');
        if (isReasoningEvent) {
            logger.debug("[ThreadWithMemoryStrategy] Skipping reasoning event", {
                eventId: event.id.substring(0, 8),
                pubkey: event.pubkey.substring(0, 8)
            });
            return [];
        }

        // Check if this is a tool event from this agent
        const isToolEvent = event.tags.some(t => t[0] === 'tool');
        const isThisAgent = event.pubkey === agentPubkey;

        if (isToolEvent) {
            const toolName = event.tagValue("tool")
            console.log('Found a tool event', toolName)
            if (isThisAgent) {
                // Load tool messages from storage
                const toolMessages = await toolMessageStorage.load(event.id);
                if (toolMessages) {
                    messages.push(...toolMessages);
                    return messages;
                }
            } else {
                // Try to get the agent that published this event
                if (isProjectContextInitialized()) {
                    const projectCtx = getProjectContext();
                    const otherAgent = projectCtx.getAgentByPubkey(event.pubkey);
                    if (otherAgent) {
                        console.log(`Skipping tool event from agent: ${otherAgent.slug} (${otherAgent.name})`);
                    } else {
                        console.log(`Skipping tool event from unknown agent with pubkey: ${event.pubkey.substring(0, 8)}`);
                    }
                } else {
                    console.log("Skipping tool event from a different agent from thread");
                }
                return [];
            }
        } else {
            console.log('Not a tool event')
        }

        // Process regular message - only strip thinking blocks, don't process entities
        const content = await this.processEventContent(event, agentPubkey);

        // Use EventToModelMessage for proper attribution
        const result = await EventToModelMessage.transform(
            event,
            content,
            agentPubkey,
            conversationId
        );

        // Handle both single message and array of messages (for phase transitions)
        const messagesToAdd = Array.isArray(result) ? result : [result];
        messages.push(...messagesToAdd);

        // If not from this agent and contains nostr entities, append system messages with entity content
        if (event.pubkey !== agentPubkey) {
            const entityMessages = await this.processNostrEntities(event.content || '');
            if (entityMessages.length > 0) {
                messages.push(...entityMessages);
            }
        }

        // console.log(chalk.green("Turning event"), event.inspect, chalk.green("into message(s)"), chalk.white(JSON.stringify(messagesToAdd)));

        return messages;
    }

    /**
     * Process event content (only strip thinking blocks, keep nostr entities intact)
     */
    private async processEventContent(event: NDKEvent): Promise<string> {
        let content = event.content || '';

        // Strip thinking blocks
        content = this.stripThinkingBlocks(content);

        // Don't process entities - keep original nostr: references intact
        return content;
    }

    /**
     * Strip thinking blocks from content
     */
    private stripThinkingBlocks(content: string): string {
        return content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
    }

    /**
     * Process nostr entities and create system messages for them
     */
    private async processNostrEntities(content: string): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];
        
        // Extract nostr entities from content
        const entities = NostrEntityProcessor.extractEntities(content);
        if (entities.length === 0) {
            return messages;
        }

        const ndk = getNDK();
        const nameRepo = getPubkeyNameRepository();

        for (const entity of entities) {
            try {
                const bech32Id = entity.replace("nostr:", "");
                const event = await ndk.fetchEvent(bech32Id);

                if (event) {
                    // Get author name
                    const authorName = await nameRepo.getName(event.pubkey);
                    
                    // Format timestamp
                    const timestamp = new Date(event.created_at * 1000).toISOString();
                    
                    // Create system message with event content
                    const systemContent = `Nostr event ${bech32Id.substring(0, 12)}... published by ${authorName} on ${timestamp}:\n\n${event.content}`;
                    
                    messages.push({
                        role: "system",
                        content: systemContent
                    });

                    logger.debug("[ThreadWithMemoryStrategy] Added nostr entity as system message", {
                        entity,
                        kind: event.kind,
                        author: authorName,
                        contentLength: event.content?.length || 0,
                    });
                }
            } catch (error) {
                logger.warn("[ThreadWithMemoryStrategy] Failed to fetch nostr entity", {
                    entity,
                    error,
                });
                // Skip entity if fetch fails
            }
        }

        return messages;
    }

    /**
     * Add system prompt based on context
     */
    private async addSystemPrompt(
        messages: ModelMessage[],
        context: ExecutionContext
    ): Promise<void> {
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);
        if (!conversation) return;

        if (isProjectContextInitialized()) {
            // Project mode
            const projectCtx = getProjectContext();
            const project = projectCtx.project;
            const availableAgents = Array.from(projectCtx.agents.values());
            const agentLessonsMap = new Map();
            const currentAgentLessons = projectCtx.getLessonsForAgent(context.agent.pubkey);

            if (currentAgentLessons.length > 0) {
                agentLessonsMap.set(context.agent.pubkey, currentAgentLessons);
            }

            const isProjectManager = context.agent.pubkey === projectCtx.getProjectManager().pubkey;

            const systemMessages = buildSystemPromptMessages({
                agent: context.agent,
                project,
                availableAgents,
                conversation,
                agentLessons: agentLessonsMap,
                isProjectManager,
                projectManagerPubkey: projectCtx.getProjectManager().pubkey,
            });

            for (const systemMsg of systemMessages) {
                messages.push(systemMsg.message);
            }
        } else {
            // Fallback minimal prompt
            messages.push({
                role: "system",
                content: `You are ${context.agent.name}. ${context.agent.instructions || ""}`,
            });
        }
    }


    /**
     * Add special context instructions (voice mode, debug mode, delegation completion, etc.)
     */
    private async addSpecialContext(
        messages: ModelMessage[],
        context: ExecutionContext,
        triggeringEvent: NDKEvent
    ): Promise<void> {
        const contextBuilder = new PromptBuilder();

        // Add voice mode instructions if applicable
        if (isVoiceMode(triggeringEvent)) {
            contextBuilder.add("voice-mode", { isVoiceMode: true });

            logger.info("[ThreadWithMemoryStrategy] Voice mode activated", {
                agent: context.agent.name
            });
        }

        // Add delegation completion fragment if needed
        if (context.isDelegationCompletion) {
            contextBuilder.add("delegation-completion", {
                isDelegationCompletion: true
            });

            logger.info("[ThreadWithMemoryStrategy] Added delegation completion context", {
                agent: context.agent.name
            });
        }

        // Add debug mode fragment if needed
        if (isDebugMode(triggeringEvent)) {
            contextBuilder.add("debug-mode", { enabled: true });

            logger.info("[ThreadWithMemoryStrategy] Debug mode activated", {
                agent: context.agent.name
            });
        }

        // Build and add any special context instructions
        const contextInstructions = contextBuilder.build();
        if (contextInstructions) {
            messages.push({ role: "system", content: contextInstructions });
        }
    }
}