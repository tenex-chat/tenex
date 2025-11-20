import { ThreadedConversationFormatter } from "@/conversations/formatters/ThreadedConversationFormatter";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { EventToModelMessage } from "@/conversations/processors/EventToModelMessage";
// Utility imports
import { hasReasoningTag } from "@/conversations/utils/content-utils";
import { addAllSpecialContexts } from "@/conversations/utils/context-enhancers";
import { getNDK } from "@/nostr";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services/ProjectContext";
import { NudgeService } from "@/services/NudgeService";
import { getPubkeyNameRepository } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import {
    extractNostrEntities,
    resolveNostrEntitiesToSystemMessages,
} from "@/utils/nostr-entity-parser";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import type { ExecutionContext } from "../types";
import type { MessageGenerationStrategy } from "./types";

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
        triggeringEvent: NDKEvent,
        eventFilter?: (event: NDKEvent) => boolean
    ): Promise<ModelMessage[]> {
        const { threadService } = context.conversationCoordinator;
        const conversation = context.getConversation();

        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        const messages: ModelMessage[] = [];

        // Add system prompt
        await this.addSystemPrompt(messages, context);

        // 1. Get current thread (from root to triggering event)
        logger.debug("[ThreadWithMemoryStrategy] Getting thread for triggering event", {
            triggeringEventId: triggeringEvent.id.substring(0, 8),
            triggeringContent: triggeringEvent.content?.substring(0, 50),
            triggeringParent: triggeringEvent.tagValue("e")?.substring(0, 8),
            historySize: conversation.history.length,
        });

        let currentThread = threadService.getThreadToEvent(
            triggeringEvent.id,
            conversation.history
        );

        // Apply event filter if provided (e.g., for Claude Code session resumption)
        if (eventFilter) {
            const originalLength = currentThread.length;
            const originalEvents = currentThread.map((e) => ({
                id: e.id.substring(0, 8),
                content: e.content?.substring(0, 30),
            }));
            currentThread = currentThread.filter(eventFilter);
            const remainingEvents = currentThread.map((e) => ({
                id: e.id.substring(0, 8),
                content: e.content?.substring(0, 30),
            }));
            logger.info("[ThreadWithMemoryStrategy] Applied event filter to current thread", {
                originalLength,
                filteredLength: currentThread.length,
                eventsRemoved: originalLength - currentThread.length,
                originalEvents,
                remainingEvents,
            });
        }

        logger.debug("[ThreadWithMemoryStrategy] Current thread retrieved", {
            conversationId: context.conversationId.substring(0, 8),
            agentName: context.agent.name,
            currentThreadLength: currentThread.length,
            triggeringEventId: triggeringEvent.id.substring(0, 8),
            threadEvents: currentThread.slice(0, 5).map((e) => ({
                id: e.id.substring(0, 8),
                content: e.content?.substring(0, 30),
                pubkey: e.pubkey?.substring(0, 8),
            })),
        });

        // 2. Create a Set of event IDs from the active branch
        const activeBranchIds = new Set<string>(currentThread.map((e) => e.id));

        logger.debug("[ThreadWithMemoryStrategy] Active branch identified", {
            activeBranchSize: activeBranchIds.size,
            activeBranchIds: Array.from(activeBranchIds)
                .slice(0, 5)
                .map((id) => id.substring(0, 8)),
        });

        // 3. Get ALL events in the conversation and format other branches
        let allEvents = conversation.history;

        // Apply event filter to all events if provided
        if (eventFilter) {
            const originalLength = allEvents.length;
            allEvents = allEvents.filter(eventFilter);
            logger.info(
                "[ThreadWithMemoryStrategy] Applied event filter to all events for other branches",
                {
                    originalLength,
                    filteredLength: allEvents.length,
                    eventsRemoved: originalLength - allEvents.length,
                }
            );
        }

        const formatter = new ThreadedConversationFormatter();
        const otherBranchesFormatted = await formatter.formatOtherBranches(
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
                content: `You were active in these other related subthreads in this conversation:\n\n${enhancedContent}`,
            });

            logger.debug("[ThreadWithMemoryStrategy] Added agent memory from other branches", {
                agentName: context.agent.name,
            });

            // 4. Add current thread context (FULL thread from root to current)
            messages.push({
                role: "system",
                content: "Current thread you are responding to:",
            });
        } else {
            logger.debug("[ThreadWithMemoryStrategy] No other branches with agent participation", {
                agentName: context.agent.name,
            });
        }

        logger.debug("[ThreadWithMemoryStrategy] Adding current thread events", {
            threadLength: currentThread.length,
            firstEvent: currentThread[0]
                ? {
                      id: currentThread[0].id.substring(0, 8),
                      content: currentThread[0].content?.substring(0, 30),
                  }
                : null,
            lastEvent: currentThread[currentThread.length - 1]
                ? {
                      id: currentThread[currentThread.length - 1].id.substring(0, 8),
                      content: currentThread[currentThread.length - 1].content?.substring(0, 30),
                  }
                : null,
        });

        // Process and add ALL events in current thread
        for (let i = 0; i < currentThread.length; i++) {
            const event = currentThread[i];
            const isTriggeringEvent = event.id === triggeringEvent.id;

            const processedMessages = await this.processEvent(
                event,
                context.agent.pubkey,
                context.conversationId
            );
            messages.push(...processedMessages);

            logger.debug("[ThreadWithMemoryStrategy] Added event to messages", {
                eventId: event.id.substring(0, 8),
                eventContent: event.content?.substring(0, 30),
                messageCount: processedMessages.length,
                isAgent: event.pubkey === context.agent.pubkey,
                isTriggeringEvent,
            });
        }

        // Add special context instructions if needed
        await addAllSpecialContexts(
            messages,
            triggeringEvent,
            context.isDelegationCompletion || false,
            context.agent.name
        );

        logger.debug("[ThreadWithMemoryStrategy] Message building complete", {
            totalMessages: messages.length,
            hasMemoryFromOtherThreads: otherBranchesFormatted !== null,
            currentThreadLength: currentThread.length,
        });

        return messages;
    }

    /**
     * Enhance formatted content with agent names
     */
    private async enhanceFormattedContent(
        formattedContent: string,
        _agentPubkey: string,
        _agentName: string
    ): Promise<string> {
        // This is a simplified version - in the future we could parse
        // the formatted content and replace pubkeys with names
        // For now, just return the formatted content as-is
        return formattedContent;
    }

    /**
     * Process a single event into messages
     */
    private async processEvent(
        event: NDKEvent,
        agentPubkey: string,
        conversationId: string
    ): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];

        // Skip reasoning events - they should not be included in context
        if (hasReasoningTag(event)) {
            logger.debug("[ThreadWithMemoryStrategy] Skipping reasoning event", {
                eventId: event.id.substring(0, 8),
                pubkey: event.pubkey.substring(0, 8),
            });
            return [];
        }

        // Check if this is a tool event from this agent
        const isToolEvent = event.tags.some((t) => t[0] === "tool");
        const isThisAgent = event.pubkey === agentPubkey;

        if (isToolEvent) {
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
                        console.log(
                            `Skipping tool event from agent: ${otherAgent.slug} (${otherAgent.name})`
                        );
                    } else {
                        console.log(
                            `Skipping tool event from unknown agent with pubkey: ${event.pubkey.substring(0, 8)}`
                        );
                    }
                } else {
                    console.log("Skipping tool event from a different agent from thread");
                }
                return [];
            }
        }

        // Process regular message
        const content = event.content || "";

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
            const entities = extractNostrEntities(event.content || "");
            if (entities.length > 0) {
                try {
                    const nameRepo = getPubkeyNameRepository();
                    const ndk = getNDK();
                    const entitySystemMessages = await resolveNostrEntitiesToSystemMessages(
                        event.content || "",
                        ndk,
                        (pubkey) => nameRepo.getName(pubkey)
                    );

                    for (const systemContent of entitySystemMessages) {
                        messages.push({
                            role: "system",
                            content: systemContent,
                        });
                    }
                } catch (error) {
                    logger.warn("[ThreadWithMemoryStrategy] Failed to resolve nostr entities", {
                        error,
                        eventId: event.id.substring(0, 8),
                    });
                    // Continue without entity resolution if NDK is not available
                }
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
        const conversation = context.getConversation();
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

            const systemMessages = await buildSystemPromptMessages({
                agent: context.agent,
                project,
                projectPath: context.projectPath,
                availableAgents,
                conversation,
                agentLessons: agentLessonsMap,
                isProjectManager,
                projectManagerPubkey: projectCtx.getProjectManager().pubkey,
            });

            for (const systemMsg of systemMessages) {
                messages.push(systemMsg.message);
            }

            // Add nudges if present on triggering event
            const nudgeIds = AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent);
            if (nudgeIds.length > 0) {
                logger.debug("[ThreadWithMemoryStrategy] Injecting nudges", {
                    agent: context.agent.slug,
                    nudgeCount: nudgeIds.length,
                    conversationId: context.conversationId.substring(0, 8),
                });

                const nudgeService = NudgeService.getInstance();
                const nudgeContent = await nudgeService.fetchNudges(nudgeIds);
                if (nudgeContent) {
                    messages.push({
                        role: "system",
                        content: nudgeContent,
                    });

                    logger.info("[ThreadWithMemoryStrategy] Nudges injected successfully", {
                        agent: context.agent.slug,
                        nudgeCount: nudgeIds.length,
                        contentLength: nudgeContent.length,
                    });
                } else {
                    logger.debug("[ThreadWithMemoryStrategy] Nudge content was empty", {
                        agent: context.agent.slug,
                        nudgeCount: nudgeIds.length,
                    });
                }
            }
        } else {
            // Fallback minimal prompt
            messages.push({
                role: "system",
                content: `You are ${context.agent.name}. ${context.agent.instructions || ""}`,
            });
        }
    }
}
