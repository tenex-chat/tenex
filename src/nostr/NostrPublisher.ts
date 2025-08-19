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


// Context passed to publisher on creation
export interface NostrPublisherContext {
    conversationId: string;
    agent: AgentInstance;
    triggeringEvent: NDKEvent;
    replyTarget?: NDKEvent;  // Optional: what to reply to (if different from trigger)
    conversationManager: ConversationManager;
}

// Options for publishing responses
export interface ResponseOptions {
    content: string;
    llmMetadata?: LLMMetadata;
    completeMetadata?: Complete;
    additionalTags?: string[][];
    destinationPubkeys?: string[];
}

// TENEX logging types
interface TenexLogData {
    event: string;
    agent: string;
    details: Record<string, unknown>;
    timestamp?: number;
}

// Metadata for finalizing stream
interface FinalizeMetadata {
    llmMetadata?: LLMMetadata;
    completeMetadata?: Complete;
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

    /**
     * Publishes an agent's response to Nostr and updates the conversation state.
     *
     * IMPORTANT: This method follows a save-then-publish pattern for transactional integrity:
     * 1. First updates the conversation state in memory
     * 2. Then saves the conversation to persistent storage
     * 3. Only after successful save does it publish to Nostr
     *
     * This ensures that we never have events on the network that aren't reflected
     * in our local state, preventing state inconsistencies.
     */
    async publishResponse(options: ResponseOptions): Promise<NDKEvent> {
        try {
            const reply = this.createBaseReply();

            // Just use the content provided by the caller
            reply.content = options.content;

            // Add metadata tags
            this.addLLMMetadata(reply, options.llmMetadata);

            // Debug logging for metadata
            logger.debug("Adding metadata to response", {
                hasLLMMetadata: !!options.llmMetadata,
                llmModel: options.llmMetadata?.model,
                llmCost: options.llmMetadata?.cost,
                hasCompleteMetadata: !!options.completeMetadata,
            });

            // Add p-tags for destination pubkeys if provided
            // If no destination pubkeys provided, default to the reply target's author (if available)
            // or the triggering event's author. This ensures agents respond to the right person.
            const defaultPubkey = this.context.replyTarget?.pubkey || this.context.triggeringEvent.pubkey;
            const destinationPubkeys = options.destinationPubkeys || [defaultPubkey];
            
            for (const pubkey of destinationPubkeys) {
                console.log("skipping adding p tag for", pubkey, "since this isnt a complete tool use")
                // reply.tag(["p", pubkey]);
            }

            // Add any additional tags
            if (options.additionalTags) {
                for (const tag of options.additionalTags) {
                    reply.tag(tag);
                }
            }

            // With the new simplified system, we don't need to manually add messages to context
            // The conversation history (NDKEvents) is the source of truth
            // Just save the conversation state BEFORE publishing
            await this.context.conversationManager.saveConversation(this.context.conversationId);

            // Sign and publish only after local state is successfully updated
            await reply.sign(this.context.agent.signer);
            await reply.publish();

            const conversation = this.getConversation();
            logger.debug("Published agent response", {
                eventId: reply.id,
                contentLength: options.content.length,
                agent: this.context.agent.name,
                phase: conversation.phase,
            });

            return reply;
        } catch (error) {
            logger.error("Failed to publish response", {
                agent: this.context.agent.name,
                error: formatAnyError(error),
            });
            throw error;
        }
    }

    async publishError(message: string): Promise<NDKEvent> {
        try {
            const reply = this.createBaseReply();
            reply.content = message;
            reply.tag(["error", "system"]);

            await reply.sign(this.context.agent.signer);
            await reply.publish();

            logger.debug("Published error notification", {
                eventId: reply.id,
                error: message,
                agent: this.context.agent.name,
            });

            return reply;
        } catch (error) {
            logger.error("Failed to publish error", {
                agent: this.context.agent.name,
                error: formatAnyError(error),
            });
            throw error;
        }
    }

    async publishTenexLog(logData: TenexLogData): Promise<NDKEvent> {
        try {
            const event = new NDKEvent(getNDK());
            event.kind = EVENT_KINDS.TENEX_LOG;
            
            // Set timestamp
            const timestamp = logData.timestamp || Math.floor(Date.now() / 1000);
            event.created_at = timestamp;
            
            // Create structured content
            event.content = JSON.stringify({
                event: logData.event,
                agent: logData.agent,
                details: logData.details,
                timestamp,
            });
            
            // Add base tags
            this.addBaseTags(event);
            
            // Add conversation reference
            event.tag(["e", this.context.conversationId]);
            
            // Add TENEX-specific tags
            event.tag(["tenex-event", logData.event]);
            event.tag(["tenex-agent", logData.agent]);
            
            await event.sign(this.context.agent.signer);
            await event.publish();
            
            logger.debug("Published TENEX log", {
                eventId: event.id,
                tenexEvent: logData.event,
                agent: logData.agent,
            });
            
            return event;
        } catch (error) {
            logger.error("Failed to publish TENEX log", {
                agent: this.context.agent.name,
                tenexEvent: logData.event,
                error: formatAnyError(error),
            });
            throw error;
        }
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

            const event = new NDKEvent(getNDK());
            event.kind =
                state === "stop"
                    ? EVENT_KINDS.TYPING_INDICATOR_STOP
                    : EVENT_KINDS.TYPING_INDICATOR;

            // Use provided message or default
            if (state === "start") {
                event.content = message || `${agent.name} is typing`;
            } else {
                event.content = "";
            }

            // Add base tags (project, phase)
            this.addBaseTags(event);

            // Add conversation references
            event.tag(["e", this.context.conversationId]);

            await event.sign(this.context.agent.signer);
            event.publish();

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

