import { NDKEvent, NDKTask, NDKKind } from "@nostr-dev-kit/ndk";
import { EVENT_KINDS } from "@/llm/types";
import { logger } from "@/utils/logger";
import { getNDK } from "@/nostr/ndkClient";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { getProjectContext } from "@/services";

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

export interface ErrorIntent {
    type: 'error';
    message: string;
    errorType?: string;
}

export interface TypingIntent {
    type: 'typing';
    state: 'start' | 'stop';
    message?: string;
}

export interface StreamingIntent {
    type: 'streaming';
    content: string;
    sequence: number;
}

export interface StatusIntent {
    type: 'status';
    agents: Array<{ pubkey: string; slug: string }>;
    models: Array<{ slug: string; agents: string[] }>;
    tools: Array<{ name: string; agents: string[] }>;
    queue?: string[];
}

export interface LessonIntent {
    type: 'lesson';
    title: string;
    lesson: string;
    detailed?: string;
    category?: string;
    hashtags?: string[];
}

export type AgentIntent = CompletionIntent | DelegationIntent | ConversationIntent | ErrorIntent | TypingIntent | StreamingIntent | StatusIntent | LessonIntent;

// Execution context provided by RAL
export interface EventContext {
    triggeringEvent: NDKEvent;
    conversationEvent?: NDKEvent; // Optional - not all events belong to conversations
    delegatingAgentPubkey?: string; // For task completions
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

// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export  class AgentEventEncoder {
    /**
     * Add conversation tags consistently to any event.
     * Centralizes conversation tagging logic for all agent events.
     */
    private static addConversationTags(event: NDKEvent, context: EventContext): void {
        if (!context.conversationEvent || !context.conversationEvent.id) {
            throw new Error('EventContext is missing required conversationEvent - this event type requires conversation context');
        }
        if (!context.triggeringEvent || !context.triggeringEvent.id) {
            throw new Error('EventContext is missing required triggeringEvent with id');
        }
        
        // Add conversation root tag (E tag) - using the conversation event's ID
        event.tag(['E', context.conversationEvent.id]);
        
        // Add reply to triggering event (e tag)
        event.tag(['e', context.triggeringEvent.id]);
    }
    /**
     * Encode a completion intent into a tagged event.
     * Completion events mark the end of a flow branch with specific E-tag semantics.
     */
    static encodeCompletion(intent: CompletionIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.GenericReply;
        event.content = intent.content;

        // Add conversation tags
        this.addConversationTags(event, context);
        
        // Mark this as a completion with tool tag
        event.tag(['tool', 'complete']);

        // Completion metadata
        if (intent.summary) {
            event.tag(['summary', intent.summary]);
        }

        // If this is a task completion, p-tag the delegating agent
        if (context.delegatingAgentPubkey) {
            event.tag(['p', context.delegatingAgentPubkey]);
        }

        // Add standard metadata
        this.addStandardTags(event, context);
        
        logger.debug("Encoded completion event", {
            eventId: event.id,
            hasCompletedTags: true,
            summary: intent.summary,
            hasDelegatingAgent: !!context.delegatingAgentPubkey
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
            task.tag(['p', recipientPubkey]);

            // Phase information for multi-phase flows
            if (intent.phase) {
                task.tag(['phase', intent.phase]);
            }

            // Add conversation tags for context
            this.addConversationTags(task, context);
            
            // Mark this as a delegation with tool tag
            task.tag(['tool', 'delegate']);

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
        event.kind = NDKKind.GenericReply;
        event.content = intent.content;

        // Add conversation tags
        this.addConversationTags(event, context);


        // Add standard metadata
        this.addStandardTags(event, context);

        return event;
    }

    /**
     * Add standard metadata tags that all agent events should have.
     * Centralizes common tagging logic.
     */
    private static addStandardTags(event: NDKEvent, context: EventContext): void {
        // Add project tag - ALL agent events should reference their project
        const projectCtx = getProjectContext();
        event.tag(projectCtx.project);

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
    }

    /**
     * Encode an error intent into an error event.
     */
    static encodeError(intent: ErrorIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.GenericReply;
        event.content = intent.message;
        
        // Add conversation tags
        this.addConversationTags(event, context);
        
        // Mark as error
        event.tag(['error', intent.errorType || 'system']);
        
        // Add standard metadata
        this.addStandardTags(event, context);
        
        return event;
    }

    /**
     * Encode a typing indicator intent.
     */
    static encodeTypingIndicator(intent: TypingIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        
        // Use appropriate event kind based on state
        if (intent.state === 'start') {
            event.kind = EVENT_KINDS.TYPING_INDICATOR;
            event.content = intent.message || `${context.agent.name} is typing`;
        } else {
            // Stop event uses different kind
            event.kind = EVENT_KINDS.TYPING_INDICATOR_STOP;
            event.content = '';
        }
        
        // Add conversation reference (not full conversation tags) if available
        if (context.conversationEvent && context.conversationEvent.id) {
            event.tag(['e', context.conversationEvent.id]);
        }
        
        // Add project tag
        const projectCtx = getProjectContext();
        event.tag(projectCtx.project);
        
        return event;
    }

    /**
     * Encode a streaming progress intent.
     */
    static encodeStreamingProgress(intent: StreamingIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = EVENT_KINDS.STREAMING_RESPONSE;
        event.content = intent.content;
        
        // Tag the conversation
        event.tag(['e', context.triggeringEvent.id]);
        event.tag(['streaming', 'true']);
        event.tag(['sequence', intent.sequence.toString()]);
        
        // Add agent info
        event.tag(['p', context.agent.pubkey]);
        
        return event;
    }

    /**
     * Encode a project status intent.
     */
    static encodeProjectStatus(intent: StatusIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = EVENT_KINDS.PROJECT_STATUS;
        event.content = '';
        
        // Add project tag
        const projectCtx = getProjectContext();
        event.tag(projectCtx.project);
        
        // Add agent pubkeys
        for (const agent of intent.agents) {
            event.tag(['agent', agent.pubkey, agent.slug]);
        }
        
        // Add model access tags
        for (const model of intent.models) {
            event.tag(['model', model.slug, ...model.agents]);
        }
        
        // Add tool access tags
        for (const tool of intent.tools) {
            event.tag(['tool', tool.name, ...tool.agents]);
        }
        
        // Add queue tags if present
        if (intent.queue) {
            for (const conversationId of intent.queue) {
                event.tag(['queue', conversationId]);
            }
        }
        
        return event;
    }

    /**
     * Encode a lesson learned intent.
     */
    static encodeLesson(intent: LessonIntent, context: EventContext): NDKAgentLesson {
        const lessonEvent = new NDKAgentLesson(getNDK());
        
        // Set core properties
        lessonEvent.title = intent.title;
        lessonEvent.lesson = intent.lesson;
        
        // Set optional properties
        if (intent.detailed) {
            lessonEvent.detailed = intent.detailed;
        }
        if (intent.category) {
            lessonEvent.category = intent.category;
        }
        if (intent.hashtags && intent.hashtags.length > 0) {
            lessonEvent.hashtags = intent.hashtags;
        }
        
        // Add reference to the agent event if available
        if (context.agent.eventId) {
            lessonEvent.agentDefinitionId = context.agent.eventId;
        }
        
        // Add project tag
        const projectCtx = getProjectContext();
        lessonEvent.tag(projectCtx.project);
        
        return lessonEvent;
    }
}

