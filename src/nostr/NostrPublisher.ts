import type { AgentInstance } from "@/agents/types";
import { getTotalExecutionTimeSeconds } from "@/conversations/executionTime";
import type { Conversation } from "@/conversations/types";
import type { ConversationManager } from "@/conversations/ConversationManager";
import { EVENT_KINDS } from "@/llm/types";
import { getNDK } from "@/nostr";
import { EXECUTION_TAGS } from "@/nostr/tags";
import type { LLMMetadata } from "@/nostr/types";
import { getProjectContext } from "@/services";
import type { Complete } from "@/tools/types";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { TypingIndicatorManager } from "./TypingIndicatorManager";
import { AgentPublisher } from "./AgentPublisher";
import type { TypingIntent, EventContext } from "./AgentEventEncoder";


// Context passed to publisher on creation
export interface NostrPublisherContext {
    conversationId: string;
    agent: AgentInstance;
    triggeringEvent: NDKEvent;
    replyTarget?: NDKEvent;  // Optional: what to reply to (if different from trigger)
    conversationManager: ConversationManager;
}


// TENEX logging types
interface TenexLogData {
    event: string;
    agent: string;
    details: Record<string, unknown>;
    timestamp?: number;
}


export class NostrPublisher {
    private typingIndicatorManager: TypingIndicatorManager;
    
    constructor(public readonly context: NostrPublisherContext) {
        this.typingIndicatorManager = new TypingIndicatorManager(this);
    }
    
    /**
     * Clean up any resources (e.g., pending timers).
     */
    async cleanup(): Promise<void> {
        // Force stop typing indicator if still active
        await this.typingIndicatorManager.forceStop();
        this.typingIndicatorManager.cleanup();
    }

    private getConversation(): Conversation {
        const conversation = this.context.conversationManager.getConversation(
            this.context.conversationId
        );
        if (!conversation) {
            throw new Error(
                `Conversation not found in ConversationManager: ${this.context.conversationId}`
            );
        }
        return conversation;
    }


    async publishTypingIndicator(state: "start" | "stop", message?: string): Promise<NDKEvent | void> {
        // Use the typing indicator manager for start calls
        if (state === "start") {
            return await this.typingIndicatorManager.start(message);
        } else {
            // For stop calls, use the manager's stop method which handles timing
            await this.typingIndicatorManager.stop();
            return;
        }
    }
    
    /**
     * Internal method used by TypingIndicatorManager to publish raw typing events.
     * This bypasses the timing logic and publishes immediately.
     */
    async publishTypingIndicatorRaw(state: "start" | "stop", message?: string): Promise<NDKEvent> {
        try {
            const { agent } = this.context;

            // Create typing intent
            const intent: TypingIntent = {
                type: 'typing',
                state,
                message: state === "start" ? (message || `${agent.name} is typing`) : undefined
            };

            // Create event context
            const eventContext: EventContext = {
                agent: this.context.agent,
                triggeringEvent: this.context.triggeringEvent,
                conversationId: this.context.conversationId
            };

            // Use AgentPublisher to create and publish the event
            const agentPublisher = new AgentPublisher(this.context.agent);
            const event = await agentPublisher.typing(intent, eventContext);

            logger.debug(`Published typing indicator ${state}`, {
                conversationId: this.context.conversationId,
                author: event.pubkey,
                agent: this.context.agent.name,
                message: state === "start" ? event.content : undefined,
            });

            return event;
        } catch (error) {
            logger.error(`Failed to publish typing indicator ${state}`, {
                agent: this.context.agent.name,
                error: formatAnyError(error),
            });
            throw error;
        }
    }

    // Public helper methods
    public createBaseReply(): NDKEvent {
        // Use replyTarget if available, otherwise use triggeringEvent
        const eventToReplyTo = this.context.replyTarget || this.context.triggeringEvent;
        const reply = eventToReplyTo.reply();

        // When the event to reply to has E tag, replace e tag with E tag value
        const ETag = eventToReplyTo.tagValue("E");
        if (ETag) {
            reply.removeTag("e");
            reply.tags.push(["e", ETag]);
        }

        // Still tag the actual triggering event for debugging
        reply.tags.push(["triggering-event-id", this.context.triggeringEvent.id]);
        reply.tags.push([
            "triggering-event-content",
            this.context.triggeringEvent.content.substring(0, 50),
        ]);

        this.addBaseTags(reply);
        this.cleanPTags(reply);
        return reply;
    }

    private addBaseTags(event: NDKEvent): void {
        const conversation = this.getConversation();

        // Always add project tag
        const { project } = getProjectContext();
        event.tag(project.tagReference());

        // Always add current phase tag from the single source of truth
        const currentPhase = conversation.phase;
        event.tag(["phase", currentPhase]);

        // Always add execution time tag using the fresh conversation object
        const totalSeconds = getTotalExecutionTimeSeconds(conversation);
        event.tag([EXECUTION_TAGS.NET_TIME, totalSeconds.toString()]);

        // Add voice mode tag if the triggering event has it
        if (this.context.triggeringEvent.tagValue("mode") === "voice") {
            event.tag(["mode", "voice"]);
        }
    }

    private cleanPTags(event: NDKEvent): void {
        // Remove all p-tags added by NDK's reply() method to ensure clean routing
        event.tags = event.tags.filter((tag) => tag[0] !== "p");
    }

    public addLLMMetadata(event: NDKEvent, metadata?: LLMMetadata): void {
        if (!metadata) {
            logger.debug("[NostrPublisher] No metadata to add");
            return;
        }

        logger.debug("[NostrPublisher] Adding LLM metadata to event", {
            eventId: event.id,
            model: metadata.model,
            cost: metadata.cost,
            promptTokens: metadata.promptTokens,
            completionTokens: metadata.completionTokens,
            totalTokens: metadata.totalTokens,
            hasSystemPrompt: !!metadata.systemPrompt,
            hasUserPrompt: !!metadata.userPrompt,
            systemPromptLength: metadata.systemPrompt?.length || 0,
            userPromptLength: metadata.userPrompt?.length || 0,
        });

        event.tag(["llm-model", metadata.model]);
        event.tag(["llm-cost-usd", metadata.cost.toFixed(8)]);
        event.tag(["llm-prompt-tokens", metadata.promptTokens.toString()]);
        event.tag(["llm-completion-tokens", metadata.completionTokens.toString()]);
        event.tag(["llm-total-tokens", metadata.totalTokens.toString()]);

        if (metadata.contextWindow) {
            event.tag(["llm-context-window", metadata.contextWindow.toString()]);
        }
        if (metadata.maxCompletionTokens) {
            event.tag(["llm-max-completion-tokens", metadata.maxCompletionTokens.toString()]);
        }
        if (metadata.systemPrompt) {
            // event.tag(["llm-system-prompt", metadata.systemPrompt]);
        }
        if (metadata.userPrompt) {
            event.tag(["llm-user-prompt", metadata.userPrompt]);
        }
        if (metadata.rawResponse) {
            event.tag(["llm-raw-response", metadata.rawResponse]);
        }
        
        logger.debug("[NostrPublisher] ✅ Metadata tags added", {
            eventId: event.id,
            totalTags: event.tags.length,
            metadataTags: event.tags.filter(t => t[0].startsWith("llm-")).length,
        });
    }

}

