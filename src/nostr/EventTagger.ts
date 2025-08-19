import type { AgentInstance } from "@/agents/types";
import { getTotalExecutionTimeSeconds } from "@/conversations/executionTime";
import type { Conversation } from "@/conversations/types";
import type { Phase } from "@/conversations/phases";
import { EXECUTION_TAGS, LLM_TAGS } from "@/nostr/tags";
import type { LLMMetadata } from "@/nostr/types";
import { logger } from "@/utils/logger";
import { NDKEvent, type NDKProject } from "@nostr-dev-kit/ndk";

/**
 * EventTagger centralizes all event tagging logic in the TENEX system.
 * 
 * This class encapsulates the "recipes" for tagging events based on their
 * conceptual intent (delegation, completion, response) rather than requiring
 * clients to know the specific tags needed for each use case.
 * 
 * The primary goals are:
 * - Single source of truth for tagging requirements
 * - Intent-based API (what, not how)
 * - Testability of tagging logic
 * - Maintainability when tag standards change
 */
export class EventTagger {
    constructor(
        private readonly project: NDKProject
    ) {}

    /**
     * Tags an event as a DELEGATION of work from one agent to another.
     * Focuses only on delegation-specific tags.
     */
    tagForDelegation(
        event: NDKEvent,
        context: {
            assignedTo: string | string[];      // Pubkey(s) of assigned agent(s)
            conversationId: string;             // Conversation root for context
        }
    ): void {
        const { assignedTo, conversationId } = context;
        
        // Ensure assignedTo is always an array for consistent handling
        const assignees = Array.isArray(assignedTo) ? assignedTo : [assignedTo];
        
        // Add assignee p-tags - the core of delegation
        for (const pubkey of assignees) {
            event.tag(["p", pubkey]);
        }
        
        // Link to conversation root for context
        event.tag(["e", conversationId, "", "root"]);
        
        logger.debug("Tagged event for delegation", {
            eventId: event.id,
            assignees: assignees.length,
            conversationId
        });
    }

    /**
     * Tags an event as a COMPLETION of a previously delegated task.
     * Includes all tags needed for proper completion handling.
     */
    tagForCompletion(
        event: NDKEvent,
        context: {
            originalTaskId: string;              // The task being completed
            originalTaskPubkey: string;          // Who to route the completion to
            status: 'completed' | 'failed';      // Completion status
        }
    ): void {
        const { originalTaskId, originalTaskPubkey, status } = context;
        
        // Reference the original task
        event.tag(["e", originalTaskId, "", "reply"]);
        
        // Add completion status
        event.tag(["status", status]);
        
        // Mark this as a completion tool event
        event.tag(["tool", "complete"]);
        
        // Route back to delegator (the author of the original task)
        event.tag(["p", originalTaskPubkey]);
        
        logger.debug("Tagged event for completion", {
            eventId: event.id,
            originalTaskId,
            status,
            routingTo: originalTaskPubkey
        });
    }

    /**
     * Tags an event as an IN-CONVERSATION RESPONSE from an agent.
     * This maintains all conversation continuity requirements.
     */
    tagForConversationResponse(
        event: NDKEvent,
        context: {
            conversation: Conversation;
            respondingAgent: AgentInstance;
            triggeringEvent: NDKEvent;          // What triggered this response
            destinationPubkeys?: string[];      // Who to route response to
        }
    ): void {
        const { conversation, respondingAgent, triggeringEvent, destinationPubkeys } = context;
        
        // Handle E-tag replacement for proper threading
        this.handleETagReplacement(event, triggeringEvent);
        
        // Add triggering event context
        event.tag(["triggering-event-id", triggeringEvent.id]);
        event.tag([
            "triggering-event-content",
            triggeringEvent.content.substring(0, 50)
        ]);
        
        // Add conversation threading
        if (!event.tagValue("e")) {
            // Only add if not already set by E-tag replacement
            event.tag(["e", conversation.id]);
        }
        
        // Add phase tracking
        event.tag(["phase", conversation.phase]);
        
        // Add project reference
        this.addProjectReference(event);
        
        // Add execution metrics
        this.addExecutionTime(event, conversation);
        
        // Propagate voice mode if present
        this.propagateVoiceMode(event, triggeringEvent);
        
        // Add routing p-tags
        const recipients = destinationPubkeys || [triggeringEvent.pubkey];
        for (const pubkey of recipients) {
            event.tag(["p", pubkey]);
        }
        
        // Track responding agent
        event.tag(["responding-agent", respondingAgent.pubkey]);
        
        logger.debug("Tagged event for conversation response", {
            eventId: event.id,
            triggeringEventId: triggeringEvent.id,
            phase: conversation.phase,
            respondingAgent: respondingAgent.name,
            recipientCount: recipients.length,
            hasVoiceMode: triggeringEvent.tagValue("mode") === "voice"
        });
    }

    /**
     * Adds project reference to any event.
     * Utility method for consistent project tagging.
     */
    addProjectReference(event: NDKEvent): void {
        event.tag(this.project.tagReference());
    }

    /**
     * Adds LLM metadata to any event.
     * Utility method for consistent LLM cost/usage tracking.
     */
    addLLMMetadata(event: NDKEvent, metadata?: LLMMetadata): void {
        if (!metadata) return;
        
        event.tag([LLM_TAGS.MODEL, metadata.model]);
        event.tag([LLM_TAGS.COST_USD, metadata.cost.toFixed(8)]);
        event.tag([LLM_TAGS.PROMPT_TOKENS, metadata.promptTokens.toString()]);
        event.tag([LLM_TAGS.COMPLETION_TOKENS, metadata.completionTokens.toString()]);
        event.tag([LLM_TAGS.TOTAL_TOKENS, metadata.totalTokens.toString()]);
        
        if (metadata.contextWindow) {
            event.tag([LLM_TAGS.CONTEXT_WINDOW, metadata.contextWindow.toString()]);
        }
        if (metadata.maxCompletionTokens) {
            event.tag([LLM_TAGS.MAX_COMPLETION_TOKENS, metadata.maxCompletionTokens.toString()]);
        }
        
        logger.debug("Added LLM metadata to event", {
            eventId: event.id,
            model: metadata.model,
            cost: metadata.cost,
            totalTokens: metadata.totalTokens
        });
    }

    // ============================================
    // PRIVATE HELPERS
    // ============================================

    private propagateVoiceMode(event: NDKEvent, triggeringEvent: NDKEvent): void {
        if (triggeringEvent.tagValue("mode") === "voice") {
            event.tag(["mode", "voice"]);
        }
    }

    private handleETagReplacement(event: NDKEvent, triggeringEvent: NDKEvent): void {
        const ETag = triggeringEvent.tagValue("E");
        if (ETag) {
            // Remove any existing e-tags
            event.tags = event.tags.filter(tag => tag[0] !== "e");
            // Add the E-tag value as the primary e-tag
            event.tag(["e", ETag]);
        }
    }

    private addExecutionTime(event: NDKEvent, conversation: Conversation): void {
        const totalSeconds = getTotalExecutionTimeSeconds(conversation);
        if (totalSeconds !== undefined && totalSeconds !== null) {
            event.tag([EXECUTION_TAGS.NET_TIME, totalSeconds.toString()]);
        }
    }
}