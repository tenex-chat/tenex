import type { AgentConfig, AgentInstance } from "@/agents/types";
import { EVENT_KINDS } from "@/llm/types";
import { getNDK } from "@/nostr/ndkClient";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { agentsRegistryService } from "@/services/AgentsRegistryService";
import { logger } from "@/utils/logger";
import {
  NDKEvent,
  type NDKTask,
  type NDKPrivateKeySigner,
  type NDKProject,
} from "@nostr-dev-kit/ndk";
import {
  AgentEventEncoder,
  type CompletionIntent,
  type ConversationIntent,
  type DelegationIntent,
  type AskIntent,
  type ErrorIntent,
  type EventContext,
  type LessonIntent,
  type StreamingIntent,
  type TypingIntent,
  type ToolUseIntent,
} from "./AgentEventEncoder";

/**
 * Comprehensive publisher for all agent-related Nostr events.
 * Handles agent creation, responses, completions, and delegations.
 * Also manages streaming buffer to ensure correct event ordering.
 */
export class AgentPublisher {
  private agent: AgentInstance;
  private encoder: AgentEventEncoder;
  private streamSequence = 0;

  constructor(agent: AgentInstance) {
    this.agent = agent;
    this.encoder = new AgentEventEncoder();
  }


  /**
   * Publish a completion event.
   * Creates and publishes a properly tagged completion event.
   */
  async complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent> {
    logger.debug("Dispatching completion", {
      agent: this.agent.name,
      contentLength: intent.content.length,
      summary: intent.summary,
    });

    const event = this.encoder.encodeCompletion(intent, context);

    // Sign and publish
    await this.agent.sign(event);
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
    const events = this.encoder.encodeDelegation(intent, context);

    // Sign the event (should be single event now)
    for (const event of events) {
      await this.agent.sign(event);
    }
    
    // Register delegation using the new clean interface
    const registry = DelegationRegistry.getInstance();
    const mainEvent = events[0]; // Should only be one event now
    
    // Removed redundant logging - registration is logged in DelegationRegistry
    
    const batchId = await registry.registerDelegation({
      delegationEventId: mainEvent.id,
      recipients: intent.recipients.map(recipientPubkey => ({
        pubkey: recipientPubkey,
        request: intent.request,
        phase: intent.phase,
      })),
      delegatingAgent: this.agent,
      rootConversationId: context.rootEvent.id,
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
   * Publish delegation follow-up request event.
   * Creates and publishes a follow-up event as a reply to a previous delegation response.
   */
  async delegateFollowUp(
    intent: DelegationIntent,
    context: EventContext
  ): Promise<{
    events: NDKEvent[];
    batchId: string;
  }> {
    // For follow-ups, triggeringEvent should be the response event we're replying to
    const responseEvent = context.triggeringEvent;
    const recipientPubkey = intent.recipients[0]; // Follow-ups are always to single recipient
    
    logger.debug("[AgentPublisher] Creating follow-up event", {
      agent: this.agent.name,
      recipientPubkey: recipientPubkey.substring(0, 8),
      responseEventId: responseEvent.id?.substring(0, 8),
    });
    
    // Use encoder to create the follow-up event
    const followUpEvent = this.encoder.encodeFollowUp(responseEvent, intent.request);
    
    // Sign the event
    await this.agent.sign(followUpEvent);
    
    // Register with DelegationRegistry for tracking
    const registry = DelegationRegistry.getInstance();
    const batchId = await registry.registerDelegation({
      delegationEventId: followUpEvent.id,
      recipients: [{
        pubkey: recipientPubkey,
        request: intent.request,
        phase: intent.phase,
      }],
      delegatingAgent: this.agent,
      rootConversationId: context.rootEvent.id,
      originalRequest: intent.request,
    });
    
    // Publish the follow-up event
    await followUpEvent.publish();
    
    logger.debug("Follow-up event published", {
      eventId: followUpEvent.id?.substring(0, 8),
      replyingTo: responseEvent.id?.substring(0, 8),
      batchId,
    });
    
    return { events: [followUpEvent], batchId };
  }

  /**
   * Publish an ask event.
   * Creates and publishes an event asking a question to the project manager/human user.
   */
  async ask(
    intent: AskIntent,
    context: EventContext
  ): Promise<{
    event: NDKEvent;
    batchId: string;
  }> {
    logger.debug("[AgentPublisher] Publishing ask event", {
      agent: this.agent.name,
      content: intent.content,
      hasSuggestions: !!intent.suggestions,
      suggestionCount: intent.suggestions?.length,
    });

    const event = this.encoder.encodeAsk(intent, context);

    // Sign the event
    await this.agent.sign(event);

    // Get project owner pubkey for registration
    const projectCtx = await import("@/services").then(m => m.getProjectContext());
    const ownerPubkey = projectCtx?.project?.pubkey;

    if (!ownerPubkey) {
      throw new Error("No project owner configured - cannot determine who to ask");
    }

    // Register with DelegationRegistry for tracking (ask uses delegation infrastructure)
    const registry = DelegationRegistry.getInstance();
    const batchId = await registry.registerDelegation({
      delegationEventId: event.id,
      recipients: [{
        pubkey: ownerPubkey,
        request: intent.content,
      }],
      delegatingAgent: this.agent,
      rootConversationId: context.rootEvent.id,
      originalRequest: intent.content,
    });

    // Publish the event
    await event.publish();

    logger.debug("Ask event published", {
      eventId: event.id?.substring(0, 8),
      batchId,
    });

    return { event, batchId };
  }

  /**
   * Publish a conversation response.
   * Creates and publishes a standard response event.
   */
  async conversation(intent: ConversationIntent, context: EventContext): Promise<NDKEvent> {
    logger.debug("Dispatching conversation response", {
      agent: this.agent.name,
      contentLength: intent.content.length,
    });

    const event = this.encoder.encodeConversation(intent, context);

    // Sign and publish
    await this.agent.sign(event);
    await event.publish();

    return event;
  }


  /**
   * Publish an error event.
   * Creates and publishes an error notification event.
   */
  async error(intent: ErrorIntent, context: EventContext): Promise<NDKEvent> {
    logger.debug("Dispatching error", {
      agent: this.agent.name,
      error: intent.message,
    });

    const event = this.encoder.encodeError(intent, context);

    // Sign and publish
    await this.agent.sign(event);
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
    await this.agent.sign(event);
    await event.publish();

    return event;
  }

  /**
   * Publish a streaming progress event.
   */
  async streaming(intent: StreamingIntent, context: EventContext): Promise<NDKEvent> {
    // Note: Don't flush stream for streaming events as they ARE the stream
    const event = this.encoder.encodeStreamingContent(intent, context);

    // Sign and publish
    await this.agent.sign(event);
    await event.publish();

    logger.info("[AgentPublisher] Streaming event published", {
      eventId: event.id?.substring(0, 8),
      kind: event.kind,
      contentLength: intent.content.length,
      isReasoning: intent.isReasoning,
      sequence: intent.sequence
    });

    return event;
  }

  /**
   * Publish a lesson learned event.
   */
  async lesson(intent: LessonIntent, context: EventContext): Promise<NDKEvent> {
    logger.debug("Dispatching lesson", {
      agent: this.agent.name,
    });

    const lessonEvent = this.encoder.encodeLesson(intent, context, this.agent);

    // Sign and publish
    await this.agent.sign(lessonEvent);
    await lessonEvent.publish();

    logger.debug("Lesson event published", {
      eventId: lessonEvent.id,
      agent: this.agent.name,
    });

    return lessonEvent;
  }

  /**
   * Publish a tool usage event.
   * Creates and publishes an event with tool name and output tags.
   */
  async toolUse(intent: ToolUseIntent, context: EventContext): Promise<NDKEvent> {
    logger.debug("Dispatching tool usage", {
      agent: this.agent.name,
      tool: intent.toolName,
      contentLength: intent.content.length,
    });

    const event = this.encoder.encodeToolUse(intent, context);

    // Sign and publish
    await this.agent.sign(event);
    await event.publish();

    logger.debug("Tool usage event published", {
      eventId: event.id,
      agent: this.agent.name,
      tool: intent.toolName,
    });

    return event;
  }

  /**
   * Publish streaming delta from LLMService.
   * Content is already throttled by the middleware, so we publish immediately as kind:21111.
   */
  async publishStreamingDelta(
    delta: string,
    context: EventContext,
    isReasoning = false
  ): Promise<void> {
    // Content is already buffered/throttled by the middleware
    // Just publish it immediately as a streaming event
    const streamingIntent: StreamingIntent = {
      content: delta,
      sequence: ++this.streamSequence,
      isReasoning,
    };

    logger.info("[AgentPublisher] Publishing streaming event (21111) for pre-buffered content", {
      contentLength: delta.length,
      sequence: streamingIntent.sequence,
      isReasoning,
      contentPreview: delta.substring(0, 50) + (delta.length > 50 ? "..." : ""),
      agentName: this.agent.name
    });

    await this.streaming(streamingIntent, context);
  }

  /**
   * Reset streaming sequence counter.
   * Should be called when streaming is complete.
   */
  resetStreamingSequence(): void {
    this.streamSequence = 0;
  }


  /**
   * Create a task event that references the triggering event.
   * Used for Claude Code and other task-based executions.
   */
  async createTask(
    title: string,
    content: string,
    context: EventContext,
    claudeSessionId?: string,
  ): Promise<NDKTask> {
    // Use encoder to create task with proper tagging
    const task = this.encoder.encodeTask(
      title,
      content,
      context,
      claudeSessionId,
    );

    // Sign with agent's signer
    await this.agent.sign(task);
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
    context: EventContext,
    status = "in-progress"
  ): Promise<NDKEvent> {
    const update = task.reply();
    update.content = content;

    // Strip all "p" tags (no notifications)
    update.tags = update.tags.filter(t => t[0] !== "p");

    // Add standard tags using existing encoder methods
    this.encoder.addStandardTags(update, context);

    update.tag(["status", status]);
    await this.agent.sign(update);
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
    agentDefinitionEventId?: string,
    agentMetadata?: {
      description?: string;
      instructions?: string;
      useCriteria?: string;
      phases?: Record<string, string>;
    }
  ): Promise<void> {
    let profileEvent: NDKEvent;

    try {
      // Deterministically select avatar family based on pubkey
      const avatarFamilies = ["lorelei", "miniavs", "dylan", "pixel-art", "rings", "avataaars"];
      // Use first few chars of pubkey to select family deterministically
      const familyIndex = parseInt(signer.pubkey.substring(0, 8), 16) % avatarFamilies.length;
      const avatarStyle = avatarFamilies[familyIndex];
      const seed = signer.pubkey; // Use pubkey as seed for consistent avatar
      const avatarUrl = `https://api.dicebear.com/7.x/${avatarStyle}/svg?seed=${seed}`;

      const profile = {
        name: agentName,
        description: `${agentRole} agent for ${projectTitle}`,
        picture: avatarUrl,
      };

      profileEvent = new NDKEvent(getNDK(), {
        kind: 0,
        pubkey: signer.pubkey,
        content: JSON.stringify(profile),
        tags: [],
      });

      // Properly tag the project event (creates an "a" tag for kind:31933)
      profileEvent.tag(projectEvent.tagReference());
      
      // Add "a" tags for all projects this agent belongs to
      const projectTags = await agentsRegistryService.getProjectsForAgent(signer.pubkey);
      for (const tag of projectTags) {
        profileEvent.tag(["a", tag]);
      }

      // Add e-tag for the agent definition event if it exists and is valid
      if (agentDefinitionEventId) {
        // Validate that it's a proper hex event ID (64 characters)
        profileEvent.tags.push(["e", agentDefinitionEventId]);
      }

      // Add metadata tags for agents without NDKAgentDefinition event ID
      if (!agentDefinitionEventId && agentMetadata) {
        if (agentMetadata.description) {
          profileEvent.tags.push(["description", agentMetadata.description]);
        }
        if (agentMetadata.instructions) {
          profileEvent.tags.push(["instructions", agentMetadata.instructions]);
        }
        if (agentMetadata.useCriteria) {
          profileEvent.tags.push(["use-criteria", agentMetadata.useCriteria]);
        }
        if (agentMetadata.phases) {
          // Add phase tags with instructions
          for (const [phaseName, instructions] of Object.entries(agentMetadata.phases)) {
            profileEvent.tags.push(["phase", phaseName, instructions]);
          }
        }
      }

      await profileEvent.sign(signer, { pTags: false });
      await profileEvent.publish();
      
      // Update agent registry after successful profile publish
      const projectTag = projectEvent.tagId();
      if (projectTag) {
        await agentsRegistryService.addAgent(projectTag, signer.pubkey);
      }
    } catch (error) {
      logger.error("Failed to publish agent profile", {
        error,
        agentName,
        event: profileEvent.inspect
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

      await requestEvent.sign(signer, { pTags: false });
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
    // Prepare metadata for agents without NDKAgentDefinition
    const agentMetadata = !ndkAgentEventId ? {
      description: agentConfig.description,
      instructions: agentConfig.instructions,
      useCriteria: agentConfig.useCriteria,
      phases: agentConfig.phases
    } : undefined;

    // Publish profile event
    await AgentPublisher.publishAgentProfile(
      signer,
      agentConfig.name,
      agentConfig.role,
      projectTitle,
      projectEvent,
      ndkAgentEventId,
      agentMetadata
    );

    // Publish request event
    await AgentPublisher.publishAgentRequest(signer, agentConfig, projectEvent, ndkAgentEventId);
  }

  /**
   * Publishes a kind:3 contact list for an agent
   * This allows agents to follow other agents in the project and whitelisted pubkeys
   */
  static async publishContactList(
    signer: NDKPrivateKeySigner,
    contactPubkeys: string[]
  ): Promise<void> {
    try {
      // Create a kind:3 event (contact list)
      const contactListEvent = new NDKEvent(getNDK(), {
        kind: 3,
        pubkey: signer.pubkey,
        content: "", // Contact list content is usually empty
        tags: [],
      });

      // Add p-tags for each contact
      for (const pubkey of contactPubkeys) {
        if (pubkey && pubkey !== signer.pubkey) { // Don't follow self
          contactListEvent.tags.push(["p", pubkey]);
        }
      }

      // Sign and publish the contact list
      await contactListEvent.sign(signer, { pTags: false });
      contactListEvent.publish();
    } catch (error) {
      logger.error("Failed to publish contact list", {
        error,
        agentPubkey: signer.pubkey.substring(0, 8),
      });
      // Don't throw - contact list is not critical
    }
  }
}
