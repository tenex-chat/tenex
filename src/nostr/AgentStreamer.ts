import { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentPublisher } from "./AgentPublisher";
import { EVENT_KINDS } from "@/llm/types";
import { logger } from "@/utils/logger";
import type { EventContext } from "./AgentEventEncoder";

export interface StreamHandle {
    addContent: (content: string) => Promise<void>;
    finalize: (metadata?: any) => Promise<NDKEvent>;
}

interface StreamState {
    context: EventContext;
    accumulatedContent: string;
    sequenceNumber: number;
    lastFlushTime: number;
    pendingContent: string;
    flushTimer?: NodeJS.Timeout;
}

/**
 * Handles streaming of agent responses.
 * Manages buffering, flushing, and finalization of streaming content.
 */
export class AgentStreamer {
    private static readonly FLUSH_DELAY_MS = 500;
    private static readonly MIN_FLUSH_SIZE = 50; // Min chars before flushing
    
    private activeStreams = new Map<string, StreamState>();

    constructor(private agentPublisher: AgentPublisher) {}

    /**
     * Create a streaming handle for progressive content delivery.
     * Returns a handle that RAL can use to stream content.
     */
    createStreamHandle(context: EventContext): StreamHandle {
        const streamId = `${context.conversationId}-${Date.now()}`;
        
        const state: StreamState = {
            context,
            accumulatedContent: '',
            sequenceNumber: 0,
            lastFlushTime: Date.now(),
            pendingContent: ''
        };
        
        this.activeStreams.set(streamId, state);

        return {
            addContent: (content: string) => this.addStreamContent(streamId, content),
            finalize: (metadata?: any) => this.finalizeStream(streamId, metadata)
        };
    }

    /**
     * Add content to an active stream.
     * Handles buffering and periodic flushing of streaming events.
     */
    private async addStreamContent(streamId: string, content: string): Promise<void> {
        const state = this.activeStreams.get(streamId);
        if (!state) {
            throw new Error(`Stream ${streamId} not found`);
        }

        state.pendingContent += content;

        // Clear existing timer
        if (state.flushTimer) {
            clearTimeout(state.flushTimer);
        }

        // Check if we should flush immediately
        const shouldFlushNow = 
            state.pendingContent.length >= AgentStreamer.MIN_FLUSH_SIZE ||
            this.endsWithSentence(state.pendingContent);

        if (shouldFlushNow) {
            await this.flushStream(streamId);
        } else {
            // Schedule a flush
            state.flushTimer = setTimeout(() => {
                this.flushStream(streamId).catch(err => {
                    logger.error("Failed to flush stream on timer", {
                        streamId,
                        error: err
                    });
                });
            }, AgentStreamer.FLUSH_DELAY_MS);
        }
    }

    /**
     * Flush pending content as a streaming event.
     */
    private async flushStream(streamId: string): Promise<void> {
        const state = this.activeStreams.get(streamId);
        if (!state || !state.pendingContent) {
            return;
        }

        // Move pending to accumulated
        state.accumulatedContent += state.pendingContent;
        state.pendingContent = '';

        // Create and publish streaming event
        await this.publishStreamingEvent(state);

        state.lastFlushTime = Date.now();
    }

    /**
     * Publish a streaming event (kind:21111).
     * Uses raw event creation since this is ephemeral content.
     */
    private async publishStreamingEvent(state: StreamState): Promise<void> {
        const event = new NDKEvent();
        event.kind = EVENT_KINDS.STREAMING_RESPONSE;
        event.content = state.accumulatedContent;

        // Tag the conversation
        event.tag(['e', state.context.triggeringEvent.id]);
        event.tag(['streaming', 'true']);
        event.tag(['sequence', (++state.sequenceNumber).toString()]);

        // Add agent info
        event.tag(['p', state.context.agent.pubkey, '', 'agent']);

        // Sign and publish
        await event.sign(state.context.agent.signer);
        await event.publish();

        logger.debug("Published streaming event", {
            sequence: state.sequenceNumber,
            contentLength: state.accumulatedContent.length
        });
    }

    /**
     * Finalize a stream and publish the complete response.
     */
    private async finalizeStream(streamId: string, metadata?: any): Promise<NDKEvent> {
        const state = this.activeStreams.get(streamId);
        if (!state) {
            throw new Error(`Stream ${streamId} not found`);
        }

        // Clear any pending timer
        if (state.flushTimer) {
            clearTimeout(state.flushTimer);
        }

        // Include any remaining pending content
        const finalContent = state.accumulatedContent + state.pendingContent;

        // Merge any additional metadata into context
        const finalContext: EventContext = {
            ...state.context,
            ...metadata
        };

        // Use AgentPublisher to create the final event
        const finalEvent = await this.agentPublisher.conversation(
            {
                type: 'conversation',
                content: finalContent
            },
            finalContext
        );

        // Cleanup
        this.activeStreams.delete(streamId);

        logger.info("Stream finalized", {
            streamId,
            totalSequences: state.sequenceNumber,
            finalContentLength: finalContent.length
        });

        return finalEvent;
    }

    /**
     * Check if content ends with a sentence.
     */
    private endsWithSentence(content: string): boolean {
        return /[.!?]\s*$/.test(content.trim());
    }
}