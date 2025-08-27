import type { ConversationCoordinator } from "@/conversations";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { EVENT_KINDS } from "@/llm/types";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKKind, NDKTask } from "@nostr-dev-kit/ndk";

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
  rootEvent: NDKEvent; // Now mandatory for better type safety
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
    this.tagConversation(event, context.rootEvent);
    this.eTagParentEvent(event, context.rootEvent, context.triggeringEvent);
  }

  /**
   * Tags the root of the conversation
   */
  tagConversation(event: NDKEvent, rootEvent: NDKEvent): void {
    event.tag(["E", rootEvent.id]);
    event.tag(["K", rootEvent.kind.toString()]);
    event.tag(["P", rootEvent.pubkey]);
  }

  /**
   * "e"-tags this reply in the proper context.
   * 
   * When the triggering event has the same author as the conversation root AND
   * when the triggering event, we want to publish to the root, and not thread it in
   * the triggering event; otherwise we thread inside the triggering event.
   */
  eTagParentEvent(event: NDKEvent, rootEvent: NDKEvent, triggeringEvent: NDKEvent): void {
    const triggeringEventFromOP = triggeringEvent.pubkey === rootEvent.pubkey;
    const triggeringEventFirstLevelReply = triggeringEvent.tagValue("e") === rootEvent.id;
    const replyToOP = triggeringEventFromOP && triggeringEventFirstLevelReply;
    const replyToEvent = replyToOP ? rootEvent : triggeringEvent;

    event.tag(["e", replyToEvent.id]);
  }

  /**
   * Encode a completion intent into a tagged event.
   * Handles both regular completions and delegation completions.
   */
  encodeCompletion(intent: CompletionIntent, context: EventContext): NDKEvent {
    const event = new NDKEvent(getNDK());
    event.kind = 1111;
    event.content = intent.content;

    // Add conversation tags (E, K, P for root)
    this.tagConversation(event, context.rootEvent);
    
    // Simply e-tag the triggering event
    event.tag(["e", context.triggeringEvent.id, "", "reply"]);

    // if the triggering event is authored by the same as the root event
    // and the triggering event is e-tagging the root event, let's also e-tag the root
    // event. This is so that this completion event also shows up in the main thread.
    const pTagsMatch = context.triggeringEvent.pubkey === context.rootEvent.pubkey;
    const triggerTagsRoot = context.triggeringEvent.tagValue("e") === context.rootEvent.id;

    if (pTagsMatch && triggerTagsRoot) {
      event.tag(["e", context.rootEvent.id, "", "root"])
    }

    // p-tag the agent that triggered us
    event.tag(["p", context.triggeringEvent.pubkey]);
    
    // Mark as natural completion
    event.tag(["status", "completed"]);
    
    // Add summary if provided
    if (intent.summary) {
      event.tag(["summary", intent.summary]);
    }
      
    // Add standard metadata (LLM usage, etc)
    this.addStandardTags(event, context);

    logger.debug("Encoded completion event", {
      eventId: event.id,
      summary: intent.summary,
      completingTo: context.triggeringEvent.id?.substring(0, 8),
      completingToPubkey: context.triggeringEvent.pubkey?.substring(0, 8),
    });

    return event;
  }

  /**
   * Encode a delegation intent into kind:1111 conversation events.
   * Creates properly tagged delegation request events for each recipient.
   */
  encodeDelegation(intent: DelegationIntent, context: EventContext): NDKEvent[] {
    const events: NDKEvent[] = [];
    
    for (const recipientPubkey of intent.recipients) {
      const event = new NDKEvent(getNDK());
      event.kind = 1111; // NIP-22 comment/conversation kind
      event.content = intent.request;

      this.addConversationTags(event, context);
      
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
  public addStandardTags(event: NDKEvent, context: EventContext): void {
    this.aTagProject(event);

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
      // Format cost to avoid scientific notation and ensure proper decimal representation
      // Use toFixed with enough precision (10 decimal places) then remove trailing zeros
      const formattedCost = context.cost.toFixed(10).replace(/\.?0+$/, '');
      event.tag(["llm-cost-usd", formattedCost]);
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

    // Add conversation tags
    this.addConversationTags(event, context);

    // Add standard metadata tags (includes project tag)
    this.addStandardTags(event, context);

    return event;
  }

  /**
   * Encode a streaming progress intent.
   */
  encodeStreamingProgress(intent: StreamingIntent, context: EventContext): NDKEvent {
    const event = new NDKEvent(getNDK());
    event.kind = EVENT_KINDS.STREAMING_RESPONSE;
    event.content = intent.content;

    // Add conversation tags for proper threading
    this.addConversationTags(event, context);
    
    // Add streaming-specific tags
    event.tag(["streaming", "true"]);
    event.tag(["sequence", intent.sequence.toString()]);

    // Add standard metadata tags
    this.addStandardTags(event, context);

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
    this.aTagProject(event);

    this.pTagProjectOwner(event);

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

  aTagProject(event: NDKEvent): undefined {
    const projectCtx = getProjectContext();
    event.tag(projectCtx.project.tagReference());
  }

  /**
   * p-tags the project owner
   */
  pTagProjectOwner(event: NDKEvent): undefined {
    const projectCtx = getProjectContext();
    event.tag(["p", projectCtx.project.pubkey]);
  }
  
  /**
   * Encode a task creation with proper conversation tagging.
   * Creates an NDKTask that references the triggering event.
   */
  encodeTask(
    title: string,
    content: string,
    context: EventContext,
    claudeSessionId: string,
    branch?: string
  ): NDKTask {
    const task = new NDKTask(getNDK());
    task.title = title;
    task.content = content;

    // Add conversation tags (E, K, P for root, e for triggering)
    this.addConversationTags(task, context);

    // Add session ID
    task.tags.push(["claude-session", claudeSessionId]);

    // Add branch tag if provided
    if (branch) {
      task.tags.push(["branch", branch]);
    }

    // Add standard metadata tags (project, phase, etc)
    this.addStandardTags(task, context);

    return task;
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