import type { MessageGenerationStrategy } from "./types";
import type { ExecutionContext } from "../types";
import type { ModelMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { NostrEntityProcessor } from "@/conversations/processors/NostrEntityProcessor";
import { MessageRoleAssigner } from "@/conversations/processors/MessageRoleAssigner";
import {
    buildSystemPromptMessages
} from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { isDebugMode } from "@/prompts/fragments/debug-mode";
import { isVoiceMode } from "@/prompts/fragments/20-voice-mode";
import chalk from "chalk";

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
        const { threadService, participationIndex } = context.conversationCoordinator;
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);

        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        const messages: ModelMessage[] = [];

        // Add system prompt
        await this.addSystemPrompt(messages, context, triggeringEvent);

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

        // 2. Find ALL threads where agent participated
        const agentEventIds = participationIndex.getAgentParticipations(
            context.conversationId,
            context.agent.pubkey
        );

        logger.info("[ThreadWithMemoryStrategy] Agent participations found", {
            agentPubkey: context.agent.pubkey.substring(0, 8),
            participationCount: agentEventIds.length,
            participationIds: agentEventIds.map(id => id.substring(0, 8))
        });

        // Build a map of thread roots to full threads where agent participated
        const agentThreads: Map<string, NDKEvent[]> = new Map();
        const currentThreadIds = new Set(currentThread.map(e => e.id));

        for (const eventId of agentEventIds) {
            const thread = threadService.getThreadToEvent(eventId, conversation.history);
            if (thread.length > 0) {
                const threadRoot = thread[0].id;

                // Store the full thread (not just agent's message)
                if (!agentThreads.has(threadRoot)) {
                    agentThreads.set(threadRoot, thread);
                    logger.debug("[ThreadWithMemoryStrategy] Found agent thread", {
                        threadRoot: threadRoot.substring(0, 8),
                        threadLength: thread.length,
                        agentEventInThread: eventId.substring(0, 8)
                    });
                }
            }
        }

        logger.info("[ThreadWithMemoryStrategy] Agent threads analysis", {
            agentName: context.agent.name,
            agentThreadCount: agentThreads.size,
            currentThreadRoot: currentThread[0]?.id.substring(0, 8),
            agentThreadRoots: Array.from(agentThreads.keys()).map(id => id.substring(0, 8))
        });

        // 3. Add agent's previous threads (excluding current) with FULL context
        const currentThreadRoot = currentThread[0]?.id;
        const otherThreads = Array.from(agentThreads.entries())
            .filter(([rootId]) => rootId !== currentThreadRoot);

        if (otherThreads.length > 0) {
            messages.push({
                role: "system",
                content: "Your previous participations in other threads of this conversation (showing full thread context):"
            });

            for (const [threadRoot, thread] of otherThreads) {
                // Add thread marker
                messages.push({
                    role: "system",
                    content: `[Previous thread ${threadRoot.substring(0, 8)}]:`
                });

                // Show the FULL thread including ALL agent participations
                // The agent needs to see the complete context of what happened in this thread
                for (const event of thread) {
                    const processedMessages = await this.processEvent(
                        event,
                        context.agent.pubkey,
                        context.conversationId,
                        context.agent.slug
                    );
                    messages.push(...processedMessages);
                }
            }

            logger.info("[ThreadWithMemoryStrategy] Added agent memory from other threads", {
                otherThreadCount: otherThreads.length,
                agentName: context.agent.name
            });

            // 4. Add current thread context (FULL thread from root to current)
            messages.push({
                role: "system",
                content: "Current thread you are responding to:"
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
        for (const event of currentThread) {
            const processedMessages = await this.processEvent(
                event,
                context.agent.pubkey,
                context.conversationId,
                context.agent.slug
            );
            messages.push(...processedMessages);

            logger.debug("[ThreadWithMemoryStrategy] Added event to messages", {
                eventId: event.id.substring(0, 8),
                eventContent: event.content?.substring(0, 30),
                messageCount: processedMessages.length,
                isAgent: event.pubkey === context.agent.pubkey
            });
        }

        // Add special context instructions if needed
        await this.addSpecialContext(messages, context, triggeringEvent);

        logger.info("[ThreadWithMemoryStrategy] Message building complete", {
            totalMessages: messages.length,
            hasMemoryFromOtherThreads: otherThreads.length > 0,
            currentThreadLength: currentThread.length
        });

        return messages;
    }

    /**
     * Process a single event into messages
     */
    private async processEvent(event: NDKEvent, agentPubkey: string, conversationId: string, targetAgentSlug: string): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];

        // Check if this is a tool event from this agent
        const isToolEvent = event.tags.some(t => t[0] === 'tool');
        const isThisAgent = event.pubkey === agentPubkey;

        if (isToolEvent && isThisAgent) {
            // Load tool messages from storage
            const toolMessages = await toolMessageStorage.load(event.id);
            if (toolMessages) {
                messages.push(...toolMessages);
                return messages;
            }
        }

        // Process regular message
        const content = await this.processEventContent(event, agentPubkey);

        // Use MessageRoleAssigner for proper attribution
        const message = await MessageRoleAssigner.assignRole(
            event,
            content,
            agentPubkey,
            conversationId
        );
        messages.push(message);

        console.log(chalk.green("Turning event"), event.inspect, chalk.green("into message"), chalk.white(JSON.stringify(message)));

        return messages;
    }

    /**
     * Process event content (strip thinking blocks, process entities)
     */
    private async processEventContent(event: NDKEvent, agentPubkey: string): Promise<string> {
        let content = event.content || '';

        // Strip thinking blocks
        content = this.stripThinkingBlocks(content);

        // Process entities if it's from another agent (using static method)
        if (event.pubkey !== agentPubkey) {
            content = await NostrEntityProcessor.processEntities(content);
        }

        return content;
    }

    /**
     * Strip thinking blocks from content
     */
    private stripThinkingBlocks(content: string): string {
        return content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
    }

    /**
     * Add system prompt based on context
     */
    private async addSystemPrompt(
        messages: ModelMessage[],
        context: ExecutionContext,
        triggeringEvent: NDKEvent
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
                triggeringEvent,
                isProjectManager,
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