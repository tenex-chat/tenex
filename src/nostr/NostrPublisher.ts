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
            // If no destination pubkeys provided, default to the triggering event's author
            // This ensures agents respond to whoever triggered them (user or another agent)
            const destinationPubkeys = options.destinationPubkeys || [this.context.triggeringEvent.pubkey];
            
            for (const pubkey of destinationPubkeys) {
                reply.tag(["p", pubkey]);
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

    createStreamPublisher(): StreamPublisher {
        return new StreamPublisher(this);
    }

    // Public helper methods (made public for handleAgentCompletion)
    public createBaseReply(): NDKEvent {
        const reply = this.context.triggeringEvent.reply();

        // When the triggering event has E tag, replace e tag with E tag value
        const ETag = this.context.triggeringEvent.tagValue("E");
        if (ETag) {
            reply.removeTag("e");
            reply.tags.push(["e", ETag]);
        }

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
        event.tag(project);

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
        event.tag(["llm-cost-usd", metadata.cost.toString()]);
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

/**
 * Content segment represents a chunk of content between tool executions
 */
class ContentSegment {
    private content = "";
    private finalized = false;

    addContent(text: string): void {
        if (this.finalized) {
            throw new Error("Cannot add content to finalized segment");
        }
        this.content += text;
    }

    getContent(): string {
        return this.content;
    }

    hasContent(): boolean {
        return this.content.trim().length > 0;
    }

    markFinalized(): void {
        this.finalized = true;
    }

    isFinalized(): boolean {
        return this.finalized;
    }
}

export class StreamPublisher {
    private segments: ContentSegment[] = [];
    private currentSegment: ContentSegment;
    private pendingContent = ""; // Content waiting to be published (for streaming)
    private sequence = 0;
    private hasFinalized = false;
    private flushTimeout: NodeJS.Timeout | null = null;
    private scheduledContent = "";
    private static readonly FLUSH_DELAY_MS = 100; // Delay before actually publishing
    private static readonly SENTENCE_ENDINGS = /[.!?](?:\s|$)/; // Regex to detect sentence endings
    private lastFlushTime = Date.now();

    constructor(private readonly publisher: NostrPublisher) {
        // Initialize with first segment
        this.currentSegment = new ContentSegment();
        this.segments.push(this.currentSegment);
    }

    addContent(content: string): void {
        // Add content to current segment and pending buffer
        this.currentSegment.addContent(content);
        this.pendingContent += content;
        
        // Check if we should flush based on sentence endings
        const shouldFlushForSentence = this.shouldFlushAtSentenceEnd();
        
        // If no flush is scheduled, schedule one automatically
        if (!this.flushTimeout && !this.hasFinalized) {
            if (shouldFlushForSentence) {
                this.flush();
            } else {
                this.flush();
            }
        } else if (shouldFlushForSentence && this.flushTimeout) {
            // If we have a sentence ending and there's already a scheduled flush,
            // cancel it and flush immediately
            this.cancelScheduledFlush();
            this.flush();
        }
    }

    private shouldFlushAtSentenceEnd(): boolean {
        // Check if the pending content ends with a sentence ending
        const hasSentenceEnding = StreamPublisher.SENTENCE_ENDINGS.test(this.pendingContent);
        
        // Only flush at sentence endings if enough time has passed since last flush
        // This prevents too frequent flushing for rapid short sentences
        const timeSinceLastFlush = Date.now() - this.lastFlushTime;
        const enoughTimePassed = timeSinceLastFlush >= StreamPublisher.FLUSH_DELAY_MS;
        
        return hasSentenceEnding && enoughTimePassed;
    }

    async flush(): Promise<void> {
        // Skip if no content to flush or already finalized
        if (!this.pendingContent.trim() || this.hasFinalized) {
            return;
        }

        // If there's already a scheduled flush, we need to handle it
        if (this.flushTimeout) {
            // If a flush is already scheduled, publish it immediately and schedule the new content.
            // This prioritizes latency for the first batch while still batching subsequent content.
            this.cancelScheduledFlush();
            if (this.scheduledContent) {
                await this.publishScheduledContent();
            }
        }

        // Schedule this content to be published after a delay
        // This balances between network efficiency (batching) and user experience (low latency)
        this.scheduledContent = this.pendingContent;
        this.pendingContent = "";

        this.flushTimeout = setTimeout(async () => {
            if (!this.hasFinalized && this.scheduledContent) {
                await this.publishScheduledContent();
            }
            this.flushTimeout = null;
        }, StreamPublisher.FLUSH_DELAY_MS);
    }

    async finalize(metadata: FinalizeMetadata): Promise<NDKEvent | undefined> {
        logger.info("[DEBUG StreamPublisher.finalize] Called", {
            hasFinalized: this.hasFinalized,
            accumulatedContent: this.accumulatedContent.substring(0, 200),
            accumulatedContentLength: this.accumulatedContent.length,
            pendingContent: this.pendingContent.substring(0, 100),
            pendingContentLength: this.pendingContent.length,
            scheduledContent: this.scheduledContent.substring(0, 100),
            scheduledContentLength: this.scheduledContent.length,
            agent: this.publisher.context.agent.name,
        });

        if (this.hasFinalized) {
            throw new Error("Stream already finalized");
        }

        try {
            // Cancel any pending flush timeout
            if (this.flushTimeout) {
                this.cancelScheduledFlush();
            }

            // Move any scheduled content back to pending
            if (this.scheduledContent) {
                this.pendingContent = this.scheduledContent + this.pendingContent;
                this.scheduledContent = "";
            }

            this.hasFinalized = true;

            // Collect content from all segments
            const finalContent = this.segments
                .map(segment => segment.getContent())
                .join('')
                .trim();
            logger.info("[DEBUG StreamPublisher.finalize] Content check", {
                finalContentLength: finalContent.length,
                finalContentPreview: finalContent.substring(0, 200),
                willPublish: finalContent.length > 0,
            });

            if (finalContent.length > 0) {
                // StreamPublisher only handles text streaming, not terminal tool publishing
                // Terminal tools publish their own events directly
                logger.info("[DEBUG StreamPublisher.finalize] About to publishResponse", {
                    contentLength: finalContent.length,
                    metadata: Object.keys(metadata),
                });

                const finalEvent = await this.publisher.publishResponse({
                    content: finalContent,
                    ...metadata,
                });

                logger.info("[DEBUG StreamPublisher.finalize] publishResponse completed", {
                    eventId: finalEvent.id,
                    eventKind: finalEvent.kind,
                    eventCreatedAt: finalEvent.created_at,
                    totalSequences: this.sequence,
                    agent: this.publisher.context.agent.name,
                    finalContentLength: finalContent.length,
                });

                return finalEvent;
            }

            logger.info("[DEBUG StreamPublisher.finalize] No content to publish", {
                totalSequences: this.sequence,
                agent: this.publisher.context.agent.name,
            });

            return undefined;
        } catch (error) {
            logger.error("Failed to finalize streaming response", {
                agent: this.publisher.context.agent.name,
                error: formatAnyError(error),
            });
            throw error;
        }
    }

    isFinalized(): boolean {
        return this.hasFinalized;
    }

    getSequenceNumber(): number {
        return this.sequence;
    }

    /**
     * Get the total content accumulated by this publisher instance
     * across all segments.
     */
    getAccumulatedContent(): string {
        return this.segments
            .map(segment => segment.getContent())
            .join('');
    }

    /**
     * Called when a tool is about to be used.
     * Finalizes the current segment and starts a new one for post-tool content.
     * @param message Optional description of what the tool is doing (e.g., "📖 Reading file: foo.ts")
     *                If not provided, no typing indicator is published.
     */
    async toolUse(message?: string): Promise<void> {
        const currentContent = this.currentSegment.getContent();
        logger.info("[StreamPublisher.toolUse] Tool about to execute", {
            message: message || "(no message - tool use event skipped)",
            hasCurrentSegmentContent: this.currentSegment.hasContent(),
            isFinalized: this.hasFinalized,
            currentSegmentPreview: currentContent.substring(0, 200),
        });

        // Step 1: If current segment has content, finalize it and publish as kind:1111
        if (!this.hasFinalized && this.currentSegment.hasContent()) {
            logger.info("[StreamPublisher.toolUse] Finalizing current segment before tool execution", {
                contentLength: currentContent.length,
                contentPreview: currentContent.substring(0, 200),
            });
            
            try {
                // Mark current segment as finalized
                this.currentSegment.markFinalized();
                
                // Publish the content from all segments so far
                const contentToPublish = this.segments
                    .filter(s => s.hasContent())
                    .map(s => s.getContent())
                    .join('')
                    .trim();
                
                if (contentToPublish.length > 0) {
                    const event = await this.publisher.publishResponse({
                        content: contentToPublish,
                    });
                    logger.info("[StreamPublisher.toolUse] Segment content published successfully", {
                        eventId: event?.id,
                        eventKind: event?.kind,
                    });
                }
            } catch (error) {
                logger.error("[StreamPublisher.toolUse] Failed to publish segment content", {
                    error: formatAnyError(error),
                });
                // Don't throw - allow tool to continue even if publishing fails
            }
        }

        // Step 2: Publish the tool use indicator (only if message is provided)
        if (message) {
            try {
                await this.publisher.publishTypingIndicator("start", message);
                logger.debug("[StreamPublisher.toolUse] Published tool indicator", {
                    message,
                });
            } catch (error) {
                logger.error("[StreamPublisher.toolUse] Failed to publish tool indicator", {
                    message,
                    error: formatAnyError(error),
                });
                // Don't throw - tool can still execute
            }
        } else {
            logger.debug("[StreamPublisher.toolUse] No tool indicator published (message not provided)");
        }

        // Step 3: Start a new segment for post-tool content
        this.currentSegment = new ContentSegment();
        this.segments.push(this.currentSegment);
        
        // Reset pending content for the new segment
        this.pendingContent = "";
        this.scheduledContent = "";
        if (this.flushTimeout) {
            clearTimeout(this.flushTimeout);
            this.flushTimeout = null;
        }
        
        logger.debug("[StreamPublisher.toolUse] Started new segment for post-tool content", {
            totalSegments: this.segments.length,
        });
    }

    // Private helper methods
    private cancelScheduledFlush(): void {
        if (this.flushTimeout) {
            clearTimeout(this.flushTimeout);
            this.flushTimeout = null;
        }
    }

    private async publishScheduledContent(): Promise<void> {
        // Capture the state into local variables immediately
        const contentToPublish = this.scheduledContent;

        if (!contentToPublish.trim() || this.hasFinalized) {
            // Clear scheduled state even if we return early
            this.scheduledContent = "";
            return;
        }

        // Clear the shared state *before* the async operation
        this.scheduledContent = "";

        try {
            // Create streaming response event (ephemeral kind 21111)
            const streamingEvent = new NDKEvent(getNDK());
            streamingEvent.kind = EVENT_KINDS.STREAMING_RESPONSE; // Ephemeral streaming response kind
            // Send complete content from all segments, not just the delta
            streamingEvent.content = this.segments
                .map(segment => segment.getContent())
                .join('');
            
            // Tag the conversation
            const conversationTag = this.publisher.context.triggeringEvent.id;
            streamingEvent.tag(["e", conversationTag]);
            
            // Add streaming metadata
            this.sequence++;
            streamingEvent.tag(["streaming", "true"]);
            streamingEvent.tag(["sequence", this.sequence.toString()]);

            // Add voice mode tag if the triggering event has it
            if (this.publisher.context.triggeringEvent.tagValue("mode") === "voice") {
                streamingEvent.tag(["mode", "voice"]);
            }

            await streamingEvent.sign(this.publisher.context.agent.signer);
            streamingEvent.publish();

            // Update last flush time after successful publish
            this.lastFlushTime = Date.now();
        } catch (error) {
            // On failure, prepend content to the start of the pending buffer to be retried
            this.pendingContent = contentToPublish + this.pendingContent;
            this.sequence--; // Roll back sequence number on failure

            logger.error("Failed to publish scheduled content, content queued for retry", {
                sequence: this.sequence + 1,
                agent: this.publisher.context.agent.name,
                error: formatAnyError(error),
            });
            throw error;
        }
    }
}
