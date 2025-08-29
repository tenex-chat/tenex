import type { AgentConfig, AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import { EVENT_KINDS } from "@/llm/types";
import { getNDK } from "@/nostr/ndkClient";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { logger } from "@/utils/logger";
import {
  NDKEvent,
  NDKTask,
  type NDKPrivateKeySigner,
  type NDKProject,
} from "@nostr-dev-kit/ndk";
import {
  AgentEventEncoder,
  type CompletionIntent,
  type ConversationIntent,
  type DelegationIntent,
  type ErrorIntent,
  type EventContext,
  type LessonIntent,
  type StatusIntent,
  type StreamingIntent,
  type TypingIntent,
} from "./AgentEventEncoder";

/**
 * Comprehensive publisher for all agent-related Nostr events.
 * Handles agent creation, responses, completions, and delegations.
 * Also manages streaming buffer to ensure correct event ordering.
 */
export class AgentPublisher {
  private agent: AgentInstance;
  private encoder: AgentEventEncoder;
  
  // Streaming state - ensures buffered content is published before tool events
  private streamingBuffer?: {
    content: string;
    context: EventContext;
    sequenceNumber: number;
    metadata?: Record<string, unknown>;
  };

  constructor(agent: AgentInstance, conversationCoordinator: ConversationCoordinator) {
    this.agent = agent;
    this.encoder = new AgentEventEncoder(conversationCoordinator);
  }

  /**
   * Add content to the streaming buffer and publish streaming progress events.
   * Creates a new buffer if needed, or adds to existing buffer.
   */
  async addStreamContent(content: string, context?: EventContext): Promise<void> {
    // Initialize buffer if needed
    if (!this.streamingBuffer) {
      if (!context) {
        throw new Error("EventContext required when starting a new stream");
      }
      this.streamingBuffer = {
        content: "",
        context,
        sequenceNumber: 0,
        metadata: {},
      };
    }

    // Add content to buffer
    this.streamingBuffer.content += content;
    this.streamingBuffer.sequenceNumber++;

    // Publish streaming progress event (kind:21111)
    const streamingIntent: StreamingIntent = {
      type: "streaming",
      content: this.streamingBuffer.content,
      sequence: this.streamingBuffer.sequenceNumber,
    };
    
    await this.streaming(streamingIntent, this.streamingBuffer.context);
  }

  /**
   * Publish the buffered stream content as a final event.
   * Clears the buffer after publishing.
   */
  async publishStreamContent(metadata?: Record<string, unknown>): Promise<NDKEvent | undefined> {
    if (!this.streamingBuffer || !this.streamingBuffer.content.trim()) {
      return undefined;
    }

    // Store metadata for later use if provided
    if (metadata) {
      this.streamingBuffer.metadata = { ...this.streamingBuffer.metadata, ...metadata };
    }

    // Create a conversation intent with the buffered content
    const conversationIntent: ConversationIntent = {
      type: "conversation",
      content: this.streamingBuffer.content,
    };

    // Add metadata to context if available
    const contextWithMetadata: EventContext = {
      ...this.streamingBuffer.context,
      ...(this.streamingBuffer.metadata || {}),
    };

    // Publish as kind:1111 conversation event
    const event = this.encoder.encodeConversation(conversationIntent, contextWithMetadata);
    
    // Sign and publish
    await event.sign(this.agent.signer);
    await event.publish();

    logger.debug("Stream content published", {
      eventId: event.id,
      contentLength: this.streamingBuffer.content.length,
      sequenceCount: this.streamingBuffer.sequenceNumber,
    });

    // Clear the buffer
    this.streamingBuffer = undefined;

    return event;
  }

  /**
   * Get the current buffered content without publishing it.
   * Used by RAL for implicit completion.
   */
  getBufferedContent(): string {
    return this.streamingBuffer?.content || "";
  }

  /**
   * Check if there's buffered content.
   */
  hasBufferedContent(): boolean {
    return !!(this.streamingBuffer && this.streamingBuffer.content.trim());
  }

  /**
   * Clear the streaming buffer without publishing.
   * Used to prevent double-publishing when content is handled elsewhere.
   */
  clearBuffer(): void {
    this.streamingBuffer = undefined;
  }

  /**
   * Flush any buffered streaming content before publishing other events.
   * This ensures correct event ordering - buffered content is always published first.
   */
  private async flushStreamIfNeeded(): Promise<void> {
    if (this.streamingBuffer && this.streamingBuffer.content.trim()) {
      await this.publishStreamContent();
    }
  }

  /**
   * Publish a completion event.
   * Creates and publishes a properly tagged completion event.
   */
  async complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent> {
    // Ensure any buffered stream content is published first
    await this.flushStreamIfNeeded();
    logger.debug("Dispatching completion", {
      agent: this.agent.name,
      contentLength: intent.content.length,
      summary: intent.summary,
    });

    const event = this.encoder.encodeCompletion(intent, context);

    // Sign and publish
    await event.sign(this.agent.signer);
    await event.publish();

    logger.debug("Completion event published", {
      eventId: event.id,
      agent: this.agent.name,
    });

    return event;
  }

  /**
   * Publish delegation request events.
   * Creates and publishes a single kind:1111 conversation event with multiple p-tags.
   */
  async delegate(
    intent: DelegationIntent,
    context: EventContext
  ): Promise<{
    events: NDKEvent[];
    batchId: string;
  }> {
    // Ensure any buffered stream content is published first
    await this.flushStreamIfNeeded();
    const events = this.encoder.encodeDelegation(intent, context);

    // Sign the event (should be single event now)
    for (const event of events) {
      await event.sign(this.agent.signer);
    }
    
    // Register delegation using the new clean interface
    const registry = DelegationRegistry.getInstance();
    const mainEvent = events[0]; // Should only be one event now
    
    logger.info("📦 Registering delegation", {
      eventId: mainEvent.id?.substring(0, 8),
      recipients: intent.recipients.map(p => p.substring(0, 16)),
    });
    
    const batchId = await registry.registerDelegation({
      delegationEventId: mainEvent.id,
      recipients: intent.recipients.map(recipientPubkey => ({
        pubkey: recipientPubkey,
        request: intent.request,
        phase: intent.phase,
      })),
      delegatingAgent: this.agent,
      rootConversationId: context.rootEvent?.id || "",
      originalRequest: intent.request,
    });

    // Publish the single event
    for (const [index, event] of events.entries()) {
      await event.publish();
      logger.debug("Published delegation request", {
        index,
        eventId: event.id,
        eventIdTruncated: event.id?.substring(0, 8),
        kind: event.kind,
        assignedTo: event.tagValue("p")?.substring(0, 16),
      });
    }

    logger.debug("Delegation batch published", {
      batchId,
      eventCount: events.length,
    });

    return { events, batchId };
  }

  /**
   * Publish a conversation response.
   * Creates and publishes a standard response event.
   */
  async conversation(intent: ConversationIntent, context: EventContext): Promise<NDKEvent> {
    // Ensure any buffered stream content is published first
    await this.flushStreamIfNeeded();
    logger.debug("Dispatching conversation response", {
      agent: this.agent.name,
      contentLength: intent.content.length,
    });

    const event = this.encoder.encodeConversation(intent, context);

    // Sign and publish
    await event.sign(this.agent.signer);
    await event.publish();

    return event;
  }

  /**
   * Publish an error event.
   * Creates and publishes an error notification event.
   */
  async error(intent: ErrorIntent, context: EventContext): Promise<NDKEvent> {
    // Ensure any buffered stream content is published first
    await this.flushStreamIfNeeded();
    logger.debug("Dispatching error", {
      agent: this.agent.name,
      error: intent.message,
    });

    const event = this.encoder.encodeError(intent, context);

    // Sign and publish
    await event.sign(this.agent.signer);
    await event.publish();

    logger.debug("Error event published", {
      eventId: event.id,
      agent: this.agent.name,
      error: intent.message,
    });

    return event;
  }

  /**
   * Publish a typing indicator event.
   */
  async typing(intent: TypingIntent, context: EventContext): Promise<NDKEvent> {
    // Note: Don't flush stream for typing indicators as they're transient
    logger.debug("Dispatching typing indicator", {
      agent: this.agent.name,
      state: intent.state,
    });

    const event = this.encoder.encodeTypingIndicator(intent, context, this.agent);

    // Sign and publish
    await event.sign(this.agent.signer);
    await event.publish();

    return event;
  }

  /**
   * Publish a streaming progress event.
   */
  async streaming(intent: StreamingIntent, context: EventContext): Promise<NDKEvent> {
    // Note: Don't flush stream for streaming events as they ARE the stream
    const event = this.encoder.encodeStreamingProgress(intent, context);

    // Sign and publish
    await event.sign(this.agent.signer);
    await event.publish();

    return event;
  }

  /**
   * Publish a project status event.
   */
  async status(intent: StatusIntent): Promise<NDKEvent> {
    // Ensure any buffered stream content is published first
    await this.flushStreamIfNeeded();
    logger.debug("Dispatching status", {
      agent: this.agent.name,
      agentCount: intent.agents.length,
    });

    const event = this.encoder.encodeProjectStatus(intent);

    // Sign and publish
    await event.sign(this.agent.signer);
    await event.publish();

    return event;
  }

  /**
   * Publish a lesson learned event.
   */
  async lesson(intent: LessonIntent, context: EventContext): Promise<NDKEvent> {
    // Ensure any buffered stream content is published first
    await this.flushStreamIfNeeded();
    logger.debug("Dispatching lesson", {
      agent: this.agent.name,
    });

    const lessonEvent = this.encoder.encodeLesson(intent, context, this.agent);

    // Sign and publish
    await lessonEvent.sign(this.agent.signer);
    await lessonEvent.publish();

    logger.debug("Lesson event published", {
      eventId: lessonEvent.id,
      agent: this.agent.name,
    });

    return lessonEvent;
  }

  /**
   * Create a task event that references the triggering event.
   * Used for Claude Code and other task-based executions.
   */
  async createTask(
    title: string,
    content: string,
    context: EventContext,
    claudeSessionId: string,
    branch?: string
  ): Promise<NDKTask> {
    // Ensure any buffered stream content is published first
    await this.flushStreamIfNeeded();
    // Use encoder to create task with proper tagging
    const task = this.encoder.encodeTask(
      title,
      content,
      context,
      claudeSessionId,
      branch
    );

    // Sign with agent's signer
    await task.sign(this.agent.signer);
    await task.publish();

    logger.debug("Created task", {
      taskId: task.id,
      title,
      agent: this.agent.name,
      sessionId: claudeSessionId,
    });

    return task;
  }

  /**
   * Publish a task update (progress or completion).
   * Strips "p" tags to avoid notifications.
   */
  async publishTaskUpdate(
    task: NDKTask,
    content: string,
    context: EventContext
  ): Promise<NDKEvent> {
    // Ensure any buffered stream content is published first
    await this.flushStreamIfNeeded();
    const update = task.reply();
    update.content = content;

    // Strip all "p" tags (no notifications)
    update.tags = update.tags.filter(t => t[0] !== "p");

    // Add standard tags using existing encoder methods
    this.encoder.addStandardTags(update, context);

    await update.sign(this.agent.signer);
    await update.publish();

    logger.debug("Published task update", {
      taskId: task.id,
      contentLength: content.length,
      agent: this.agent.name,
    });

    return update;
  }

  // ===== Agent Creation Events (from src/agents/AgentPublisher.ts) =====

  /**
   * Publishes a kind:0 profile event for an agent
   */
  static async publishAgentProfile(
    signer: NDKPrivateKeySigner,
    agentName: string,
    agentRole: string,
    projectTitle: string,
    projectEvent: NDKProject,
    agentDefinitionEventId?: string
  ): Promise<void> {
    try {
      // Generate random dicebear avatar
      const avatarStyle = "bottts"; // Using bottts style for agents
      const seed = signer.pubkey; // Use pubkey as seed for consistent avatar
      const avatarUrl = `https://api.dicebear.com/7.x/${avatarStyle}/svg?seed=${seed}`;

      const profile = {
        name: agentName,
        description: `${agentRole} agent for ${projectTitle}`,
        picture: avatarUrl,
        project: projectTitle,
      };

      const profileEvent = new NDKEvent(getNDK(), {
        kind: 0,
        pubkey: signer.pubkey,
        content: JSON.stringify(profile),
        tags: [],
      });

      // Properly tag the project event (creates an "a" tag for kind:31933)
      profileEvent.tag(projectEvent.tagReference());

      // Add e-tag for the agent definition event if it exists and is valid
      if (agentDefinitionEventId) {
        // Validate that it's a proper hex event ID (64 characters)
        profileEvent.tags.push(["e", agentDefinitionEventId]);
      }

      await profileEvent.sign(signer);
      profileEvent.publish();
    } catch (error) {
      logger.error("Failed to publish agent profile", {
        error,
        agentName,
      });
      throw error;
    }
  }

  /**
   * Publishes an agent request event
   */
  static async publishAgentRequest(
    signer: NDKPrivateKeySigner,
    agentConfig: Omit<AgentConfig, "nsec">,
    projectEvent: NDKProject,
    ndkAgentEventId?: string
  ): Promise<NDKEvent> {
    try {
      const requestEvent = new NDKEvent(getNDK(), {
        kind: EVENT_KINDS.AGENT_REQUEST,
        content: "",
        tags: [],
      });

      // Properly tag the project event
      requestEvent.tag(projectEvent);

      const tags: string[][] = [];

      // Only add e-tag if this agent was created from an NDKAgentDefinition event and is valid
      if (ndkAgentEventId && ndkAgentEventId.trim() !== "") {
        // Validate that it's a proper hex event ID (64 characters)
        const trimmedId = ndkAgentEventId.trim();
        if (/^[a-f0-9]{64}$/i.test(trimmedId)) {
          tags.push(["e", trimmedId, "", "agent-definition"]);
        } else {
          logger.warn("Invalid event ID format for agent definition in request, skipping e-tag", {
            eventId: ndkAgentEventId,
          });
        }
      }

      // Add agent metadata tags
      tags.push(["name", agentConfig.name]);

      // Add the other tags
      requestEvent.tags.push(...tags);

      await requestEvent.sign(signer);
      await requestEvent.publish();

      logger.debug("Published agent request", {
        agentName: agentConfig.name,
        pubkey: signer.pubkey,
        hasNDKAgentDefinitionEvent: !!ndkAgentEventId,
      });

      return requestEvent;
    } catch (error) {
      logger.error("Failed to publish agent request", {
        error,
        agentName: agentConfig.name,
      });
      throw error;
    }
  }

  /**
   * Publishes all agent-related events when creating a new agent
   */
  static async publishAgentCreation(
    signer: NDKPrivateKeySigner,
    agentConfig: Omit<AgentConfig, "nsec">,
    projectTitle: string,
    projectEvent: NDKProject,
    ndkAgentEventId?: string
  ): Promise<void> {
    // Publish profile event
    await AgentPublisher.publishAgentProfile(
      signer,
      agentConfig.name,
      agentConfig.role,
      projectTitle,
      projectEvent,
      ndkAgentEventId
    );

    // Publish request event
    await AgentPublisher.publishAgentRequest(signer, agentConfig, projectEvent, ndkAgentEventId);
  }
}
