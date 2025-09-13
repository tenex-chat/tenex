import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { NostrEntityProcessor } from "./processors/NostrEntityProcessor";
import { MessageRoleAssigner } from "./processors/MessageRoleAssigner";
import { DelegationFormatter } from "./processors/DelegationFormatter";
import { stripThinkingBlocks, isOnlyThinkingBlocks, logThinkingBlockRemoval, hasReasoningTag } from "./utils/content-utils";
import type { AgentState, Conversation } from "./types";
import type { Phase } from "./phases";
import { toolMessageStorage } from "./persistence/ToolMessageStorage";

/**
 * Orchestrates message building for a specific agent in a conversation.
 * Single Responsibility: Coordinate the selection and ordering of messages for an agent.
 * This is now a STATELESS component that builds messages on-demand.
 * Note: Strip <thinking>...</thinking> blocks from conversation history; skip messages that are purely thinking blocks.
 */
export class AgentConversationContext {
  constructor(
    private conversationId: string,
    private agentSlug: string,
    private agentPubkey?: string
  ) {}

  /**
   * Get the thread path for an event by tracing e tags back to E tag
   * Returns array of event IDs from root to the target event
   */
  private getThreadPath(
    history: NDKEvent[],
    targetEvent: NDKEvent
  ): string[] {
    const path: string[] = [];
    const eventMap = new Map<string, NDKEvent>();
    
    // Build a map of event IDs to events for quick lookup
    for (const event of history) {
      eventMap.set(event.id, event);
    }

    // Get the root ID from E tag
    const rootId = targetEvent.tagValue("E");
    if (!rootId) {
      // No E tag means this is likely the root itself or an orphaned event
      return history.map(e => e.id);
    }

    // Trace back from target event to root via e tags
    let currentEvent: NDKEvent | undefined = targetEvent;
    const visitedIds = new Set<string>();
    
    while (currentEvent) {
      // Prevent infinite loops
      if (visitedIds.has(currentEvent.id)) {
        logger.warn("[THREAD_PATH] Circular reference detected", {
          eventId: currentEvent.id,
          conversationId: this.conversationId
        });
        break;
      }
      visitedIds.add(currentEvent.id);
      
      // Add to path (we'll reverse it later)
      path.unshift(currentEvent.id);
      
      // Check if we've reached the root
      if (currentEvent.id === rootId) {
        break;
      }
      
      // Get parent via e tag
      const parentId = currentEvent.tagValue("e");
      if (!parentId) {
        // No parent, we're at a thread root (or orphaned)
        break;
      }
      
      // If parent is the root, add it and stop
      if (parentId === rootId) {
        path.unshift(rootId);
        break;
      }
      
      // Move to parent
      currentEvent = eventMap.get(parentId);
      
      // If parent not in history, we have an incomplete thread
      if (!currentEvent) {
        logger.debug("[THREAD_PATH] Parent event not in history", {
          parentId,
          childId: path[0],
          conversationId: this.conversationId
        });
        // Try to at least include the root if we know about it
        if (eventMap.has(rootId)) {
          path.unshift(rootId);
        }
        break;
      }
    }
    
    return path;
  }

  /**
   * Filter conversation history to only include events in the thread path
   */
  private getThreadEvents(
    history: NDKEvent[],
    triggeringEvent?: NDKEvent
  ): NDKEvent[] {
    // If no triggering event, return all history (root context)
    if (!triggeringEvent) {
      return history;
    }

    // Get E and e tags to determine if this is a root or thread reply
    const rootTag = triggeringEvent.tagValue("E");
    const parentTag = triggeringEvent.tagValue("e");
    
    // If no root tag, treat as root conversation
    if (!rootTag) {
      return history;
    }
    
    // Check if this is a reply to the root (E == e or e points to root)
    const rootEvent = history.find(e => e.id === rootTag);
    const isRootReply = parentTag === rootTag || 
                       (rootEvent && parentTag === rootEvent.id);
    
    if (isRootReply) {
      // Root reply: include all chronological messages
      logger.debug("[THREAD_FILTER] Root reply detected, using full history", {
        conversationId: this.conversationId,
        rootTag,
        parentTag
      });
      return history;
    }
    
    // Thread reply: build thread-specific path
    logger.debug("[THREAD_FILTER] Thread reply detected, filtering to thread path", {
      conversationId: this.conversationId,
      rootTag,
      parentTag,
      historyLength: history.length
    });
    
    // Find the parent event we're replying to
    const parentEvent = history.find(e => e.id === parentTag);
    if (!parentEvent) {
      logger.warn("[THREAD_FILTER] Parent event not found in history", {
        parentTag,
        conversationId: this.conversationId
      });
      // Fall back to full history if we can't find the parent
      return history;
    }
    
    // Get the thread path
    const threadPath = this.getThreadPath(history, parentEvent);
    
    // Filter history to only include events in the thread path
    const threadEvents = history.filter(e => threadPath.includes(e.id));
    
    logger.debug("[THREAD_FILTER] Filtered to thread events", {
      conversationId: this.conversationId,
      originalCount: history.length,
      filteredCount: threadEvents.length,
      threadPath
    });
    
    return threadEvents;
  }

  /**
   * Filter a list of events to only include those in the same thread
   */
  private filterEventsToThread(
    events: NDKEvent[],
    triggeringEvent: NDKEvent
  ): NDKEvent[] {
    const rootTag = triggeringEvent.tagValue("E");
    const parentTag = triggeringEvent.tagValue("e");
    
    if (!rootTag) {
      return events;
    }
    
    // Check if this is a root reply
    const isRootReply = parentTag === rootTag;
    if (isRootReply) {
      return events;
    }
    
    // Get the thread path from the full conversation history
    // We need this because missed events might not have all intermediate events
    const allEvents = [...events];
    const threadPath = this.getThreadPath(allEvents, triggeringEvent);
    
    // Filter to only events in the thread path
    return events.filter(e => threadPath.includes(e.id));
  }


  /**
   * Build messages from conversation history for this agent
   * This is now a pure function that doesn't maintain state
   */
  async buildMessages(
    conversation: Conversation,
    agentState: AgentState,
    triggeringEvent?: NDKEvent,
    phaseInstructions?: string
  ): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];

    // Get thread-filtered events based on the triggering event
    const threadEvents = this.getThreadEvents(conversation.history, triggeringEvent);

    // Process history up to (but not including) the triggering event
    for (const event of threadEvents) {
      if (!event.content) continue;
      if (triggeringEvent?.id && event.id === triggeringEvent.id) {
        break; // Don't include the triggering event in history
      }

      // Check if this is a tool event from this agent
      const isToolEvent = event.hasTag("tool");
      const isThisAgent = this.agentPubkey && event.pubkey === this.agentPubkey;

      if (isToolEvent && isThisAgent) {
        // Load the full tool messages from filesystem
        const toolMessages = await toolMessageStorage.load(event.id);
        if (toolMessages) {
          messages.push(...toolMessages);
          logger.debug("[AGENT_CONTEXT] Loaded tool messages", {
            eventId: event.id.substring(0, 8),
            messageCount: toolMessages.length,
          });
        } else {
          // Fallback: use the human-readable content
          const processed = await NostrEntityProcessor.processEntities(event.content);
          const message = await MessageRoleAssigner.assignRole(
            event,
            processed,
            this.agentSlug,
            this.conversationId
          );
          messages.push(message);
        }
      } else if (!isToolEvent) {
        // Regular non-tool message processing
        
        // Skip events with reasoning tag
        if (hasReasoningTag(event)) {
          logger.debug("[AGENT_CONTEXT] Skipping event with reasoning tag", {
            eventId: event.id.substring(0, 8),
            kind: event.kind,
          });
          continue;
        }

        // Skip events that are purely thinking blocks
        if (isOnlyThinkingBlocks(event.content)) {
          logger.debug("[AGENT_CONTEXT] Skipping event with only thinking blocks", {
            eventId: event.id.substring(0, 8),
            originalLength: event.content.length,
          });
          continue;
        }

        // Strip thinking blocks from content
        const strippedContent = stripThinkingBlocks(event.content);
        logThinkingBlockRemoval(event.id, event.content.length, strippedContent.length);
        
        // Process the stripped content
        const processed = await NostrEntityProcessor.processEntities(strippedContent);
        const message = await MessageRoleAssigner.assignRole(
          event, 
          processed, 
          this.agentSlug, 
          this.conversationId
        );
        messages.push(message);
      }
      // Skip tool events from other agents
    }

    // Add phase transition message if needed
    if (phaseInstructions) {
      const phaseMessage = this.buildSimplePhaseTransitionMessage(
        agentState.lastSeenPhase,
        conversation.phase
      );
      messages.push({ role: "system", content: phaseMessage + "\n\n" + phaseInstructions });
    }

    // Add the triggering event last
    if (triggeringEvent && triggeringEvent.content) {
      // Skip if triggering event has reasoning tag
      if (hasReasoningTag(triggeringEvent)) {
        logger.debug("[AGENT_CONTEXT] Triggering event has reasoning tag, skipping", {
          eventId: triggeringEvent.id.substring(0, 8),
        });
      } else if (isOnlyThinkingBlocks(triggeringEvent.content)) {
        // Skip if triggering event is only thinking blocks
        logger.debug("[AGENT_CONTEXT] Triggering event contains only thinking blocks, skipping", {
          eventId: triggeringEvent.id.substring(0, 8),
        });
      } else {
        // Strip thinking blocks from triggering event
        const strippedContent = stripThinkingBlocks(triggeringEvent.content);
        logThinkingBlockRemoval(triggeringEvent.id, triggeringEvent.content.length, strippedContent.length);
        
        const processed = await NostrEntityProcessor.processEntities(strippedContent);
        const message = await MessageRoleAssigner.assignRole(
          triggeringEvent,
          processed,
          this.agentSlug,
          this.conversationId
        );
        messages.push(message);
      }
    }

    logger.debug(`[AGENT_CONTEXT] Built ${messages.length} messages for ${this.agentSlug}`, {
      conversationId: this.conversationId,
      hasPhaseInstructions: !!phaseInstructions,
      hasTriggeringEvent: !!triggeringEvent,
    });

    return messages;
  }

  /**
   * Build messages with missed conversation history
   * Used when an agent needs to catch up on messages they missed
   */
  async buildMessagesWithMissedHistory(
    conversation: Conversation,
    agentState: AgentState,
    missedEvents: NDKEvent[],
    delegationSummary?: string,
    triggeringEvent?: NDKEvent,
    phaseInstructions?: string
  ): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];

    // Filter missed events to only include those in the thread path
    let threadFilteredMissedEvents = triggeringEvent 
      ? this.filterEventsToThread(missedEvents, triggeringEvent)
      : missedEvents;

    // Filter out reasoning events
    threadFilteredMissedEvents = threadFilteredMissedEvents.filter(event => {
      if (hasReasoningTag(event)) {
        logger.debug("[AGENT_CONTEXT] Filtering reasoning event from missed history", {
          eventId: event.id.substring(0, 8),
        });
        return false;
      }
      return true;
    });

    // Add missed messages block if there are any
    if (threadFilteredMissedEvents.length > 0) {
      const missedBlock = await DelegationFormatter.buildMissedMessagesBlock(
        threadFilteredMissedEvents,
        this.agentSlug,
        delegationSummary
      );
      messages.push(missedBlock);
    }

    // Add phase transition if needed
    if (phaseInstructions) {
      const phaseMessage = this.buildSimplePhaseTransitionMessage(
        agentState.lastSeenPhase,
        conversation.phase
      );
      messages.push({ role: "system", content: phaseMessage + "\n\n" + phaseInstructions });
    }

    // Add triggering event
    if (triggeringEvent && triggeringEvent.content) {
      // Skip if triggering event has reasoning tag
      if (hasReasoningTag(triggeringEvent)) {
        logger.debug("[AGENT_CONTEXT] Triggering event has reasoning tag, skipping", {
          eventId: triggeringEvent.id.substring(0, 8),
        });
      } else if (isOnlyThinkingBlocks(triggeringEvent.content)) {
        // Skip if triggering event is only thinking blocks
        logger.debug("[AGENT_CONTEXT] Triggering event contains only thinking blocks, skipping", {
          eventId: triggeringEvent.id.substring(0, 8),
        });
      } else {
        // Strip thinking blocks from triggering event
        const strippedContent = stripThinkingBlocks(triggeringEvent.content);
        logThinkingBlockRemoval(triggeringEvent.id, triggeringEvent.content.length, strippedContent.length);
        
        const processed = await NostrEntityProcessor.processEntities(strippedContent);
        const message = await MessageRoleAssigner.assignRole(
          triggeringEvent,
          processed,
          this.agentSlug,
          this.conversationId
        );
        messages.push(message);
      }
    }

    return messages;
  }

  /**
   * Build messages with delegation responses
   */
  buildMessagesWithDelegationResponses(
    responses: Map<string, NDKEvent>,
    originalRequest: string,
    conversation: Conversation,
    agentState: AgentState,
    triggeringEvent?: NDKEvent,
    phaseInstructions?: string
  ): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // Add the delegation responses block
    const delegationBlock = DelegationFormatter.buildDelegationResponsesBlock(
      responses,
      originalRequest
    );
    messages.push(delegationBlock);

    // Add phase transition if needed  
    if (phaseInstructions) {
      const phaseMessage = this.buildSimplePhaseTransitionMessage(
        agentState.lastSeenPhase,
        conversation.phase
      );
      messages.push({ role: "system", content: phaseMessage + "\n\n" + phaseInstructions });
    }

    // Note: Triggering event would typically already be in the delegation responses
    // but we can add it if needed for context
    if (triggeringEvent && triggeringEvent.content) {
      logger.debug("[AGENT_CONTEXT] Adding triggering event after delegation responses", {
        eventId: triggeringEvent.id,
      });
    }

    return messages;
  }

  /**
   * Extract session ID from an event (utility method)
   */
  extractSessionId(event: NDKEvent): string | undefined {
    return event.tagValue?.("claude-session");
  }

  /**
   * Build simple phase transition message (without instructions)
   * This is the simple format, different from the full transition with instructions
   */
  private buildSimplePhaseTransitionMessage(fromPhase: Phase | undefined, toPhase: Phase): string {
    return `=== CURRENT PHASE: ${toPhase.toUpperCase()} ===`;
  }
}
