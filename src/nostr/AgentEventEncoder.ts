import type { ConversationCoordinator } from "@/conversations";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { EVENT_KINDS } from "@/llm/types";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKKind } from "@nostr-dev-kit/ndk";

/**
 * Centralized module for encoding and decoding agent event semantics.
 * This module codifies the tagging structures and their meanings,
 * ensuring consistent event creation and interpretation across the system.
 */

// Intent types that agents can express
export interface CompletionIntent {
  type: "completion";
  content: string;
  summary?: string;
}

export interface DelegationIntent {
  type: "delegation";
  recipients: string[];
  request: string;
  phase?: string;
}

export interface ConversationIntent {
  type: "conversation";
  content: string;
}

export interface ErrorIntent {
  type: "error";
  message: string;
  errorType?: string;
}

export interface TypingIntent {
  type: "typing";
  state: "start" | "stop";
  message?: string;
}

export interface StreamingIntent {
  type: "streaming";
  content: string;
  sequence: number;
}

export interface StatusIntent {
  type: "status";
  agents: Array<{ pubkey: string; slug: string }>;
  models: Array<{ slug: string; agents: string[] }>;
  tools: Array<{ name: string; agents: string[] }>;
  queue?: string[];
}

export interface LessonIntent {
  type: "lesson";
  title: string;
  lesson: string;
  detailed?: string;
  category?: string;
  hashtags?: string[];
}

export type AgentIntent =
  | CompletionIntent
  | DelegationIntent
  | ConversationIntent
  | ErrorIntent
  | TypingIntent
  | StreamingIntent
  | StatusIntent
  | LessonIntent;

// Execution context provided by RAL
export interface EventContext {
  triggeringEvent: NDKEvent;
  rootEvent?: NDKEvent; // Optional - not all events belong to conversations
  conversationId: string; // Required for conversation lookup
  toolCalls?: Array<{ name: string; arguments: unknown }>;
  executionTime?: number;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost?: number; // LLM cost in USD
  phase?: string; // Current phase for phase-aware events
}

/**
 * Encodes agent intents into properly tagged Nostr events.
 * All tagging logic is centralized here for consistency and testability.
 */
export class AgentEventEncoder {
  constructor(private conversationCoordinator: ConversationCoordinator) {}

  /**
   * Add conversation tags consistently to any event.
   * Centralizes conversation tagging logic for all agent events.
   */
  private addConversationTags(event: NDKEvent, context: EventContext): void {
    if (!context.rootEvent || !context.rootEvent.id) {
      throw new Error(
        "EventContext is missing required rootEvent - this event type requires conversation context"
      );
    }
    if (!context.triggeringEvent || !context.triggeringEvent.id) {
      throw new Error("EventContext is missing required triggeringEvent with id");
    }

    const rootEventId = context.rootEvent.id;
    const rootEventKind = context.rootEvent.kind;
    const rootEventPubkey = context.rootEvent.pubkey;

    // Add conversation root tag (E tag) - using the conversation event's ID
    event.tag(["E", rootEventId]);
    event.tag(["K", rootEventKind.toString()]);
    event.tag(["P", rootEventPubkey]);

    // Add reply to triggering event (e tag) - what we're directly replying to
    event.tag(["e", context.triggeringEvent.id]);
  }
  
  /**
   * Encode a completion intent into a tagged event.
   * Handles both regular completions and delegation completions.
   */
  encodeCompletion(intent: CompletionIntent, context: EventContext): NDKEvent {
    const event = new NDKEvent(getNDK());
    event.kind = 1111;
    event.content = intent.content;

    // we complete to the event that triggered this event
    let completeToEvent = context.triggeringEvent;

    // but wait, if the triggering event was a complete event (completion-of-completion), 
    // we need to complete to that completion's triggering event to avoid chaining
    if (context.triggeringEvent.tagValue("tool") === "complete") {
      // get the event ID that triggered the completion
      const originalTriggeringEventId = context.triggeringEvent.tagValue("e");
      
      if (originalTriggeringEventId) {
        // Fetch the actual event from conversation history
        const conversation = this.conversationCoordinator.getConversation(context.conversationId);
        if (conversation?.history) {
          const originalEvent = conversation.history.find(e => e.id === originalTriggeringEventId);
          if (originalEvent) {
            completeToEvent = originalEvent;
          }
        }
      }
    }

    // Add conversation tags (E, K, P for root)
    this.addConversationTags(event, context);
    
    // Remove the e-tag that addConversationTags added (we'll add our own)
    event.tags = event.tags.filter(t => t[0] !== "e");
    
    // Add our corrected e-tag and p-tag
    event.tag(["e", completeToEvent.id]);
    event.tag(["p", completeToEvent.pubkey]);
    
    // Mark as completion
    event.tag(["tool", "complete"]);
    
    // Add summary if provided
    if (intent.summary) {
      event.tag(["summary", intent.summary]);
    }
      
    // Add standard metadata (LLM usage, etc)
    this.addStandardTags(event, context);

    logger.debug("Encoded completion event", {
      eventId: event.id,
      summary: intent.summary,
      completingTo: completeToEvent.id?.substring(0, 8),
      completingToPubkey: completeToEvent.pubkey?.substring(0, 8),
    });

    return event;
  }

  /**
   * Encode a delegation intent into kind:1111 conversation events.
   * Creates properly tagged delegation request events for each recipient.
   */
  encodeDelegation(intent: DelegationIntent, context: EventContext): NDKEvent[] {
    if (!context.rootEvent || !context.rootEvent.id) {
      throw new Error(
        "EventContext is missing required rootEvent - this event type requires conversation context"
      );
    }

    const events: NDKEvent[] = [];
    
    // Get the root conversation ID for proper threading
    const rootEventId = context.rootEvent.tagValue("E") || context.rootEvent.id;

    for (const recipientPubkey of intent.recipients) {
      const event = new NDKEvent(getNDK());
      event.kind = 1111; // NIP-22 comment/conversation kind
      event.content = intent.request;

      // NIP-22 threading tags
      event.tag(["E", rootEventId]); // Conversation root
      event.tag(["e", context.triggeringEvent.id]); // What triggered this delegation
      
      // Recipient tag - this makes it a delegation
      event.tag(["p", recipientPubkey]);
      
      // Phase metadata if provided
      if (intent.phase) {
        event.tag(["phase", intent.phase]);
      }

      event.tag(["tool", "delegate"])

      // Add standard metadata
      this.addStandardTags(event, context);

      events.push(event);
    }

    logger.debug("Encoded delegation requests", {
      eventCount: events.length,
      phase: intent.phase,
      recipients: intent.recipients.map((r) => r.substring(0, 8)),
      kind: 1111,
    });

    return events;
  }

  /**
   * Encode a conversation intent into a response event.
   * Standard agent response without flow termination semantics.
   */
  encodeConversation(intent: ConversationIntent, context: EventContext): NDKEvent {
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
  private addStandardTags(event: NDKEvent, context: EventContext): void {
    // Add project tag - ALL agent events should reference their project
    const projectCtx = getProjectContext();
    event.tag(projectCtx.project.tagReference());

    // Tool usage metadata
    if (context.toolCalls && context.toolCalls.length > 0) {
      for (const toolCall of context.toolCalls) {
        event.tag(["tool", toolCall.name]);
      }
    }

    // Phase metadata
    if (context.phase) {
      event.tag(["phase", context.phase]);
    }

    // LLM metadata
    if (context.model) {
      event.tag(["llm-model", context.model]);
    }
    if (context.usage) {
      event.tag(["llm-prompt-tokens", context.usage.prompt_tokens.toString()]);
      event.tag(["llm-completion-tokens", context.usage.completion_tokens.toString()]);
      event.tag([
        "llm-total-tokens",
        (context.usage.prompt_tokens + context.usage.completion_tokens).toString(),
      ]);
    }
    // Add cost metadata if available
    if (context.cost !== undefined) {
      event.tag(["llm-cost-usd", context.cost.toString()]);
      
      // ============ TRACE LOGGING: Cost Tag Added ============
      console.log("🔍 [TRACE] AgentEventEncoder.ts - COST TAG ADDED");
      console.log("  Cost value:", context.cost);
      console.log("  Event kind:", event.kind);
      console.log("  All tags:", event.tags);
      console.log("================================================");
    }
    if (context.executionTime) {
      event.tag(["execution-time", context.executionTime.toString()]);
    }
  }

  /**
   * Encode an error intent into an error event.
   */
  encodeError(intent: ErrorIntent, context: EventContext): NDKEvent {
    const event = new NDKEvent(getNDK());
    event.kind = NDKKind.GenericReply;
    event.content = intent.message;

    // Add conversation tags
    this.addConversationTags(event, context);

    // Mark as error
    event.tag(["error", intent.errorType || "system"]);

    // Add standard metadata
    this.addStandardTags(event, context);

    return event;
  }

  /**
   * Encode a typing indicator intent.
   */
  encodeTypingIndicator(
    intent: TypingIntent,
    context: EventContext,
    agent: { name: string }
  ): NDKEvent {
    const event = new NDKEvent(getNDK());

    // Use appropriate event kind based on state
    if (intent.state === "start") {
      event.kind = EVENT_KINDS.TYPING_INDICATOR;
      event.content = intent.message || `${agent.name} is typing`;
    } else {
      // Stop event uses different kind
      event.kind = EVENT_KINDS.TYPING_INDICATOR_STOP;
      event.content = "";
    }

    // Add conversation reference (not full conversation tags) if available
    if (context.rootEvent?.id) {
      event.tag(["e", context.rootEvent.id]);
    }

    // Add project tag
    const projectCtx = getProjectContext();
    event.tag(projectCtx.project.tagReference());

    return event;
  }

  /**
   * Encode a streaming progress intent.
   */
  encodeStreamingProgress(intent: StreamingIntent, context: EventContext): NDKEvent {
    const event = new NDKEvent(getNDK());
    event.kind = EVENT_KINDS.STREAMING_RESPONSE;
    event.content = intent.content;

    // Tag the conversation
    event.tag(["e", context.triggeringEvent.id]);
    event.tag(["streaming", "true"]);
    event.tag(["sequence", intent.sequence.toString()]);

    return event;
  }

  /**
   * Encode a project status intent.
   */
  encodeProjectStatus(intent: StatusIntent): NDKEvent {
    const event = new NDKEvent(getNDK());
    event.kind = EVENT_KINDS.PROJECT_STATUS;
    event.content = "";

    // Add project tag
    const projectCtx = getProjectContext();
    event.tag(projectCtx.project.tagReference());

    // Add p-tag for the project owner's pubkey
    event.tag(["p", projectCtx.project.pubkey]);

    // Add agent pubkeys
    for (const agent of intent.agents) {
      event.tag(["agent", agent.pubkey, agent.slug]);
    }

    // Add model access tags
    for (const model of intent.models) {
      event.tag(["model", model.slug, ...model.agents]);
    }

    // Add tool access tags
    for (const tool of intent.tools) {
      event.tag(["tool", tool.name, ...tool.agents]);
    }

    // Add queue tags if present
    if (intent.queue) {
      for (const conversationId of intent.queue) {
        event.tag(["queue", conversationId]);
      }
    }

    return event;
  }

  /**
   * Encode a lesson learned intent.
   */
  encodeLesson(
    intent: LessonIntent,
    context: EventContext,
    agent: { eventId?: string }
  ): NDKAgentLesson {
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
    if (agent.eventId) {
      lessonEvent.agentDefinitionId = agent.eventId;
    }

    // Add standard metadata including project tag
    this.addStandardTags(lessonEvent, context);

    return lessonEvent;
  }
}