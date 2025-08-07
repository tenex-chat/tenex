import type { Agent } from "@/agents/types";
import { getTotalExecutionTimeSeconds } from "@/conversations/executionTime";
import type { Conversation } from "@/conversations/types";
import type { ConversationManager } from "@/conversations/ConversationManager";
import { EVENT_KINDS } from "@/llm/types";
import { getNDK } from "@/nostr";
import { EXECUTION_TAGS } from "@/nostr/tags";
import type { LLMMetadata } from "@/nostr/types";
import { getProjectContext } from "@/services";
import type { ContinueFlow, Complete, EndConversation } from "@/tools/types";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKEvent, type NDKTag } from "@nostr-dev-kit/ndk";
import { TypingIndicatorManager } from "./TypingIndicatorManager";

// Tool execution status interface (from ToolExecutionPublisher)
export interface ToolExecutionStatus {
    tool: string;
    status: "starting" | "running" | "completed" | "failed";
    args?: Record<string, unknown>;
    result?: unknown;
    error?: string;
    duration?: number;
}

// Context passed to publisher on creation
export interface NostrPublisherContext {
    conversationId: string;
    agent: Agent;
    triggeringEvent: NDKEvent;
    conversationManager: ConversationManager;
}

// Options for publishing responses
export interface ResponseOptions {
    content: string;
    llmMetadata?: LLMMetadata;
    continueMetadata?: ContinueFlow;
    completeMetadata?: Complete | EndConversation;
    additionalTags?: NDKTag[];
    destinationPubkeys?: string[];
}

// TENEX logging types
export interface TenexLogData {
    event: string;
    agent: string;
    details: Record<string, unknown>;
    timestamp?: number;
}

// Metadata for finalizing stream
export interface FinalizeMetadata {
    llmMetadata?: LLMMetadata;
    continueMetadata?: ContinueFlow;
    completeMetadata?: Complete | EndConversation;
}

export class NostrPublisher {
    private typingIndicatorManager: TypingIndicatorManager;
    
    constructor(public readonly context: NostrPublisherContext) {
        this.typingIndicatorManager = new TypingIndicatorManager(this);
    }
    
    /**
     * Clean up any resources (e.g., pending timers).
     */
    cleanup(): void {
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
            this.addRoutingMetadata(reply, options.continueMetadata);

            // Debug logging for metadata
            logger.debug("Adding metadata to response", {
                hasLLMMetadata: !!options.llmMetadata,
                llmModel: options.llmMetadata?.model,
                llmCost: options.llmMetadata?.cost,
                hasContinueMetadata: !!options.continueMetadata,
                hasCompleteMetadata: !!options.completeMetadata,
            });

            // Add p-tags for destination pubkeys if provided
            if (options.destinationPubkeys) {
                for (const pubkey of options.destinationPubkeys) {
                    reply.tag(["p", pubkey]);
                }
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
                state === "start"
                    ? EVENT_KINDS.TYPING_INDICATOR
                    : EVENT_KINDS.TYPING_INDICATOR_STOP;

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
            await event.publish();

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

    async publishToolStatus(status: ToolExecutionStatus): Promise<NDKEvent> {
        try {
            const event = this.context.triggeringEvent.reply();

            // Add base tags
            this.addBaseTags(event);

            // Add tool-specific tags
            event.tag(["tool", status.tool]);
            event.tag(["status", status.status]);

            // Build human-readable content (keeping existing format)
            const contentParts: string[] = [];

            switch (status.status) {
                case "starting":
                    contentParts.push(`🔧 Preparing to run ${status.tool}...`);
                    if (status.args) {
                        contentParts.push(`Parameters: ${JSON.stringify(status.args, null, 2)}`);
                    }
                    break;

                case "running":
                    contentParts.push(`🏃 Running ${status.tool}...`);
                    break;

                case "completed":
                    contentParts.push(`✅ ${status.tool} completed`);
                    if (status.duration) {
                        contentParts.push(`Duration: ${status.duration}ms`);
                    }
                    break;

                case "failed":
                    contentParts.push(`❌ ${status.tool} failed`);
                    if (status.error) {
                        contentParts.push(`Error: ${status.error}`);
                    }
                    break;
            }

            event.content = contentParts.join("\n");

            await event.sign(this.context.agent.signer);
            await event.publish();

            logger.debug("Published tool execution status", {
                tool: status.tool,
                status: status.status,
                eventId: event.id,
                agent: this.context.agent.name,
            });

            return event;
        } catch (error) {
            logger.error("Failed to publish tool execution status", {
                tool: status.tool,
                status: status.status,
                agent: this.context.agent.name,
                error: formatAnyError(error),
            });
            throw error;
        }
    }

    createStreamPublisher(): StreamPublisher {
        return new StreamPublisher(this);
    }

    // Private helper methods
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

    private addLLMMetadata(event: NDKEvent, metadata?: LLMMetadata): void {
        if (!metadata) return;

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
            event.tag(["llm-system-prompt", metadata.systemPrompt]);
        }
        if (metadata.userPrompt) {
            event.tag(["llm-user-prompt", metadata.userPrompt]);
        }
        if (metadata.rawResponse) {
            event.tag(["llm-raw-response", metadata.rawResponse]);
        }
    }

    private addRoutingMetadata(event: NDKEvent, continueMetadata?: ContinueFlow): void {
        if (!continueMetadata?.routing) return;

        const { routing } = continueMetadata;

        // Add phase information
        if (routing.phase) {
            event.tag(["new-phase", routing.phase]);
        }

        // Only add phase-transition tag if phase is actually changing
        const conversation = this.getConversation();
        const currentPhase = conversation.phase;

        const isPhaseTransition = routing.phase && routing.phase !== currentPhase;
        if (isPhaseTransition) {
            event.tag(["phase-from", currentPhase]);
        }

        // Add routing reason
        if (routing.reason) {
            event.tag(["routing-reason", routing.reason]);
        }

        // Routing message no longer exists - content is used instead

        // Add routing context summary if provided
        if (routing.context && typeof routing.context.summary === "string") {
            event.tag(["routing-summary", routing.context.summary]);
        }

        // Add agents as a tag for debugging/tracing
        if (routing.agents && routing.agents.length > 0) {
            event.tag(["routing-agents", routing.agents.join(",")]);
        }
    }
}

export class StreamPublisher {
    private pendingContent = ""; // Content waiting to be published
    private accumulatedContent = ""; // Total content accumulated so far
    private sequence = 0;
    private hasFinalized = false;
    private flushTimeout: NodeJS.Timeout | null = null;
    private scheduledContent = "";
    private static readonly FLUSH_DELAY_MS = 100; // Delay before actually publishing
    private static readonly SENTENCE_ENDINGS = /[.!?](?:\s|$)/; // Regex to detect sentence endings
    private lastFlushTime = Date.now();

    constructor(private readonly publisher: NostrPublisher) {}

    addContent(content: string): void {
        // Add content to buffers
        this.pendingContent += content;
        this.accumulatedContent += content;
        
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

            // Use accumulated content for the final reply, not just pending content
            const finalContent = this.accumulatedContent.trim();
            if (finalContent.length > 0) {
                // StreamPublisher only handles text streaming, not terminal tool publishing
                // Terminal tools publish their own events directly
                const finalEvent = await this.publisher.publishResponse({
                    content: finalContent,
                    ...metadata,
                });

                logger.debug("Finalized streaming response", {
                    totalSequences: this.sequence,
                    agent: this.publisher.context.agent.name,
                    finalContentLength: finalContent.length,
                });

                return finalEvent;
            }

            logger.debug("No content to publish in finalize", {
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
            streamingEvent.content = this.accumulatedContent; // Send complete status, not just the delta
            
            // Tag the conversation
            // First try lowercase 'e', then uppercase 'E' for legacy support
            const conversationTag = this.publisher.context.triggeringEvent.tagValue("e") || 
                                   this.publisher.context.triggeringEvent.tagValue("E") || 
                                   this.publisher.context.triggeringEvent.id;
            streamingEvent.tag(["e", conversationTag]);
            
            // Add agent identifier
            streamingEvent.tag(["p", this.publisher.context.agent.pubkey]);
            
            // Add streaming metadata
            this.sequence++;
            streamingEvent.tag(["streaming", "true"]);
            streamingEvent.tag(["sequence", this.sequence.toString()]);

            // Add voice mode tag if the triggering event has it
            if (this.publisher.context.triggeringEvent.tagValue("mode") === "voice") {
                streamingEvent.tag(["mode", "voice"]);
            }

            await streamingEvent.sign(this.publisher.context.agent.signer);
            await streamingEvent.publish();

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
