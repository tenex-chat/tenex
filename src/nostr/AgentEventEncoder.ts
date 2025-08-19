import { NDKEvent, NDKTask } from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";
import { EVENT_KINDS } from "@/llm/types";
import { logger } from "@/utils/logger";
import { getNDK } from "@/nostr/ndkClient";

/**
 * Centralized module for encoding and decoding agent event semantics.
 * This module codifies the tagging structures and their meanings,
 * ensuring consistent event creation and interpretation across the system.
 */

// Intent types that agents can express
export interface CompletionIntent {
    type: 'completion';
    content: string;
    summary?: string;
    nextAgent?: string;
}

export interface DelegationIntent {
    type: 'delegation';
    recipients: string[];
    title: string;
    request: string;
    phase?: string;
}

export interface ConversationIntent {
    type: 'conversation';
    content: string;
}

export type AgentIntent = CompletionIntent | DelegationIntent | ConversationIntent;

// Execution context provided by RAL
export interface EventContext {
    agent: AgentInstance;
    triggeringEvent: NDKEvent;
    conversationId: string;
    projectId?: string;
    toolCalls?: Array<{ name: string; arguments: any }>;
    executionTime?: number;
    model?: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

/**
 * Encodes agent intents into properly tagged Nostr events.
 * All tagging logic is centralized here for consistency and testability.
 */
export class AgentEventEncoder {
    /**
     * Encode a completion intent into a tagged event.
     * Completion events mark the end of a flow branch with specific E-tag semantics.
     */
    static encodeCompletion(intent: CompletionIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = EVENT_KINDS.AGENT_RESPONSE;
        event.content = intent.content;

        // Core flow tags - mark E-tags as completed
        const eTags = context.triggeringEvent.getMatchingTags('e');
        for (const eTag of eTags) {
            event.tag(['e', eTag[1], eTag[2] || '', 'completed']);
        }


        // Completion metadata
        if (intent.summary) {
            event.tag(['summary', intent.summary]);
        }
        if (intent.nextAgent) {
            event.tag(['next-agent', intent.nextAgent]);
        }

        // Add standard metadata
        this.addStandardTags(event, context);
        
        logger.debug("Encoded completion event", {
            eventId: event.id,
            hasCompletedTags: eTags.length > 0,
            summary: intent.summary,
            nextAgent: intent.nextAgent
        });

        return event;
    }

    /**
     * Encode a delegation intent into NDKTask events.
     * Creates properly tagged task events for each recipient.
     */
    static encodeDelegation(intent: DelegationIntent, context: EventContext): NDKTask[] {
        const tasks: NDKTask[] = [];

        for (const recipientPubkey of intent.recipients) {
            const task = new NDKTask(getNDK());
            task.content = intent.request;
            task.title = intent.title;

            // Core delegation tags
            task.tag(['p', recipientPubkey, '', 'agent']);
            

            // Phase information for multi-phase flows
            if (intent.phase) {
                task.tag(['phase', intent.phase]);
            }

            // Link to triggering event for context
            task.tag(['e', context.triggeringEvent.id, '', 'delegation-trigger']);

            // Project context
            if (context.projectId) {
                task.tag(['project', context.projectId]);
            }

            // Add standard metadata
            this.addStandardTags(task, context);

            tasks.push(task);
        }

        logger.debug("Encoded delegation tasks", {
            taskCount: tasks.length,
            phase: intent.phase,
            recipients: intent.recipients.map(r => r.substring(0, 8))
        });

        return tasks;
    }

    /**
     * Encode a conversation intent into a response event.
     * Standard agent response without flow termination semantics.
     */
    static encodeConversation(intent: ConversationIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = EVENT_KINDS.AGENT_RESPONSE;
        event.content = intent.content;

        // Simple reply tags without completion semantics
        const eTags = context.triggeringEvent.getMatchingTags('e');
        for (const eTag of eTags) {
            event.tag(['e', eTag[1], eTag[2] || '', 'reply']);
        }


        // Add standard metadata
        this.addStandardTags(event, context);

        return event;
    }

    /**
     * Add standard metadata tags that all agent events should have.
     * Centralizes common tagging logic.
     */
    private static addStandardTags(event: NDKEvent, context: EventContext): void {
        // Agent identification
        event.tag(['p', context.agent.pubkey, '', 'agent']);
        event.tag(['agent-name', context.agent.name]);

        // Conversation context
        event.tag(['conversation-id', context.conversationId]);

        // Tool usage metadata
        if (context.toolCalls && context.toolCalls.length > 0) {
            for (const toolCall of context.toolCalls) {
                event.tag(['tool', toolCall.name, JSON.stringify(toolCall.arguments)]);
            }
        }

        // LLM metadata
        if (context.model) {
            event.tag(['llm-model', context.model]);
        }
        if (context.usage) {
            event.tag(['llm-prompt-tokens', context.usage.prompt_tokens.toString()]);
            event.tag(['llm-completion-tokens', context.usage.completion_tokens.toString()]);
            event.tag(['llm-total-tokens', (context.usage.prompt_tokens + context.usage.completion_tokens).toString()]);
        }
        if (context.executionTime) {
            event.tag(['execution-time', context.executionTime.toString()]);
        }

        // Timestamp
        event.created_at = Math.floor(Date.now() / 1000);
    }
}

/**
 * Decodes Nostr events back into agent intents.
 * Used for interpreting events and understanding their semantic meaning.
 */
export class AgentEventDecoder {
    /**
     * Determine if an event represents a completion.
     */
    static isCompletionEvent(event: NDKEvent): boolean {
        // Check for completed E-tags
        const eTags = event.getMatchingTags('e');
        return eTags.some(tag => tag[3] === 'completed');
    }

    /**
     * Decode a completion event back into its intent.
     */
    static decodeCompletion(event: NDKEvent): CompletionIntent | null {
        if (!this.isCompletionEvent(event)) {
            return null;
        }

        return {
            type: 'completion',
            content: event.content,
            summary: event.tagValue('summary'),
            nextAgent: event.tagValue('next-agent')
        };
    }

    /**
     * Determine if an event is a delegation task.
     */
    static isDelegationEvent(event: NDKEvent): boolean {
        return event.kind === EVENT_KINDS.TASK && 
               event.getMatchingTags('p').some(tag => tag[3] === 'agent');
    }

    /**
     * Decode a delegation task back into its intent.
     */
    static decodeDelegation(event: NDKEvent): DelegationIntent | null {
        if (!this.isDelegationEvent(event)) {
            return null;
        }

        const task = event as NDKTask;
        const recipientTag = event.getMatchingTags('p').find(tag => tag[3] === 'agent');
        
        return {
            type: 'delegation',
            recipients: recipientTag ? [recipientTag[1]] : [],
            title: task.title || '',
            request: task.content,
            phase: event.tagValue('phase')
        };
    }

    /**
     * Extract execution context from an event.
     * Useful for understanding how an event was created.
     */
    static extractContext(event: NDKEvent): Partial<EventContext> {
        const context: Partial<EventContext> = {
            conversationId: event.tagValue('conversation-id') || '',
            projectId: event.tagValue('project'),
            model: event.tagValue('llm-model'),
            executionTime: event.tagValue('execution-time') 
                ? parseInt(event.tagValue('execution-time')!) 
                : undefined
        };

        // Extract tool calls
        const toolTags = event.getMatchingTags('tool');
        if (toolTags.length > 0) {
            context.toolCalls = toolTags.map(tag => ({
                name: tag[1],
                arguments: tag[2] ? JSON.parse(tag[2]) : {}
            }));
        }

        // Extract usage stats
        const promptTokens = event.tagValue('llm-prompt-tokens');
        const completionTokens = event.tagValue('llm-completion-tokens');
        if (promptTokens && completionTokens) {
            context.usage = {
                prompt_tokens: parseInt(promptTokens),
                completion_tokens: parseInt(completionTokens),
                total_tokens: parseInt(event.tagValue('llm-total-tokens') || '0')
            };
        }

        return context;
    }
}