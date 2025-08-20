import { NDKEvent, NDKKind, NDKTask } from "@nostr-dev-kit/ndk";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { EVENT_KINDS } from "@/llm/types";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";

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
  title: string;
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
  conversationEvent?: NDKEvent; // Optional - not all events belong to conversations
  delegatingAgentPubkey?: string; // For task completions
  toolCalls?: Array<{ name: string; arguments: unknown }>;
  executionTime?: number;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  phase?: string; // Current phase for phase-aware events
}

/**
 * Encodes agent intents into properly tagged Nostr events.
 * All tagging logic is centralized here for consistency and testability.
 */

// biome-ignore lint/complexity/noStaticOnlyClass: Static utility class for encoding event semantics
export class AgentEventEncoder {
  /**
   * Add conversation tags consistently to any event.
   * Centralizes conversation tagging logic for all agent events.
   */
  private static addConversationTags(event: NDKEvent, context: EventContext): void {
    if (!context.conversationEvent || !context.conversationEvent.id) {
      throw new Error(
        "EventContext is missing required conversationEvent - this event type requires conversation context"
      );
    }
    if (!context.triggeringEvent || !context.triggeringEvent.id) {
      throw new Error("EventContext is missing required triggeringEvent with id");
    }

    // Add conversation root tag (E tag) - using the conversation event's ID
    event.tag(["E", context.conversationEvent.id]);
    event.tag(["K", context.conversationEvent.kind.toString()]);
    event.tag(["P", context.conversationEvent.pubkey]);

    // Add reply to conversation event (e tag)
    event.tag(["e", context.conversationEvent.id]);
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
    AgentEventEncoder.addConversationTags(event, context);

    // Completion metadata
    if (intent.summary) {
      event.tag(["summary", intent.summary]);
    }

    // If this is a task completion, p-tag the delegating agent
    if (context.delegatingAgentPubkey) {
      event.tag(["p", context.delegatingAgentPubkey]);
    }

    // Add standard metadata
    AgentEventEncoder.addStandardTags(event, context);

    logger.debug("Encoded completion event", {
      eventId: event.id,
      hasCompletedTags: true,
      summary: intent.summary,
      hasDelegatingAgent: !!context.delegatingAgentPubkey,
    });

    return event;
  }

  /**
   * Encode a delegation intent into NDKTask events.
   * Creates properly tagged task events for each recipient.
   */
  static encodeDelegation(intent: DelegationIntent, context: EventContext): NDKTask[] {
    if (!context.conversationEvent || !context.conversationEvent.id) {
      throw new Error(
        "EventContext is missing required conversationEvent - this event type requires conversation context"
      );
    }

    const tasks: NDKTask[] = [];

    for (const recipientPubkey of intent.recipients) {
      const task = new NDKTask(getNDK());
      task.content = intent.request;
      task.title = intent.title;

      // Core delegation tags
      task.tag(["p", recipientPubkey]);

      // Add conversation tags for context
      task.tag(["e", context.conversationEvent.id]);

      // Add standard metadata
      AgentEventEncoder.addStandardTags(task, context);

      tasks.push(task);
    }

    logger.debug("Encoded delegation tasks", {
      taskCount: tasks.length,
      phase: intent.phase,
      recipients: intent.recipients.map((r) => r.substring(0, 8)),
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
    AgentEventEncoder.addConversationTags(event, context);

    // Add standard metadata
    AgentEventEncoder.addStandardTags(event, context);

    return event;
  }

  /**
   * Add standard metadata tags that all agent events should have.
   * Centralizes common tagging logic.
   */
  private static addStandardTags(event: NDKEvent, context: EventContext): void {
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
    if (context.executionTime) {
      event.tag(["execution-time", context.executionTime.toString()]);
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
    AgentEventEncoder.addConversationTags(event, context);

    // Mark as error
    event.tag(["error", intent.errorType || "system"]);

    // Add standard metadata
    AgentEventEncoder.addStandardTags(event, context);

    return event;
  }

  /**
   * Encode a typing indicator intent.
   */
  static encodeTypingIndicator(
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
    if (context.conversationEvent?.id) {
      event.tag(["e", context.conversationEvent.id]);
    }

    // Add project tag
    const projectCtx = getProjectContext();
    event.tag(projectCtx.project.tagReference());

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
    event.tag(["e", context.triggeringEvent.id]);
    event.tag(["streaming", "true"]);
    event.tag(["sequence", intent.sequence.toString()]);

    return event;
  }

  /**
   * Encode a project status intent.
   */
  static encodeProjectStatus(intent: StatusIntent): NDKEvent {
    const event = new NDKEvent(getNDK());
    event.kind = EVENT_KINDS.PROJECT_STATUS;
    event.content = "";

    // Add project tag
    const projectCtx = getProjectContext();
    event.tag(projectCtx.project.tagReference());

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
  static encodeLesson(
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
    AgentEventEncoder.addStandardTags(lessonEvent, context);

    return lessonEvent;
  }
}
