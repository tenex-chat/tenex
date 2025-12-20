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
import { getPubkeyService } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
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
        let currentThread = threadService.getThreadToEvent(
            triggeringEvent.id,
            conversation.history
        );

        // Apply event filter if provided (e.g., for Claude Code session resumption)
        if (eventFilter) {
            const originalLength = currentThread.length;
            currentThread = currentThread.filter(eventFilter);
            trace.getActiveSpan()?.addEvent("strategy.event_filter_applied", {
                "thread.original_length": originalLength,
                "thread.filtered_length": currentThread.length,
            });
        }

        trace.getActiveSpan()?.addEvent("strategy.thread_retrieved", {
            "conversation.id": context.conversationId.substring(0, 8),
            "agent.name": context.agent.name,
            "thread.length": currentThread.length,
        });

        // 2. Create a Set of event IDs from the active branch
        const activeBranchIds = new Set<string>(currentThread.map((e) => e.id));

        // 3. Get ALL events in the conversation and format other branches
        let allEvents = conversation.history;

        // Apply event filter to all events if provided
        if (eventFilter) {
            allEvents = allEvents.filter(eventFilter);
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

            trace.getActiveSpan()?.addEvent("strategy.other_branches_added", {
                "agent.name": context.agent.name,
            });

            // 4. Add current thread context (FULL thread from root to current)
            messages.push({
                role: "system",
                content: "Current thread you are responding to:",
            });
        }

        // Process and add ALL events in current thread
        for (let i = 0; i < currentThread.length; i++) {
            const event = currentThread[i];

            const processedMessages = await this.processEvent(
                event,
                context.agent.pubkey,
                context.conversationId
            );
            messages.push(...processedMessages);
        }

        // Add special context instructions if needed
        await addAllSpecialContexts(
            messages,
            triggeringEvent,
            context.isDelegationCompletion || false,
            context.agent.name
        );

        trace.getActiveSpan()?.addEvent("strategy.messages_built", {
            "messages.total": messages.length,
            "thread.length": currentThread.length,
            "memory.has_other_branches": otherBranchesFormatted !== null,
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
                // Skip tool events from other agents
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
                    const nameRepo = getPubkeyService();
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
                projectBasePath: context.projectBasePath,
                workingDirectory: context.workingDirectory,
                currentBranch: context.currentBranch,
                availableAgents,
                conversation,
                agentLessons: agentLessonsMap,
                isProjectManager,
                projectManagerPubkey: projectCtx.getProjectManager().pubkey,
                alphaMode: context.alphaMode,
            });

            for (const systemMsg of systemMessages) {
                messages.push(systemMsg.message);
            }

            // Add nudges if present on triggering event
            const nudgeIds = AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent);
            if (nudgeIds.length > 0) {
                const nudgeService = NudgeService.getInstance();
                const nudgeContent = await nudgeService.fetchNudges(nudgeIds);
                if (nudgeContent) {
                    messages.push({
                        role: "system",
                        content: nudgeContent,
                    });

                    trace.getActiveSpan()?.addEvent("strategy.nudges_injected", {
                        "agent.slug": context.agent.slug,
                        "nudges.count": nudgeIds.length,
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
