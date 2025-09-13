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

    logger.info("[THREAD_PATH] Starting thread path construction", {
      conversationId: this.conversationId,
      targetEventId: targetEvent.id.substring(0, 8),
      historySize: history.length,
      targetEventKind: targetEvent.kind,
      targetEventContent: targetEvent.content?.substring(0, 100)
    });

    // Build a map of event IDs to events for quick lookup
    for (const event of history) {
      eventMap.set(event.id, event);
    }
    logger.info("[THREAD_PATH] Built event map", {
      mapSize: eventMap.size,
      conversationId: this.conversationId
    });

    // Get the root ID from E tag
    const rootId = targetEvent.tagValue("E");
    logger.info("[THREAD_PATH] Extracted root ID from E tag", {
      rootId: rootId?.substring(0, 8) || "none",
      targetEventId: targetEvent.id.substring(0, 8),
      conversationId: this.conversationId
    });

    if (!rootId) {
      // No E tag means this is likely the root itself or an orphaned event
      logger.info("[THREAD_PATH] No E tag found - returning full history", {
        conversationId: this.conversationId,
        reason: "Missing E tag indicates root or orphaned event",
        returningEventCount: history.length
      });
      return history.map(e => e.id);
    }

    // Trace back from target event to root via e tags
    let currentEvent: NDKEvent | undefined = targetEvent;
    const visitedIds = new Set<string>();
    let iteration = 0;

    logger.info("[THREAD_PATH] Beginning parent traversal", {
      startingEvent: currentEvent.id.substring(0, 8),
      rootTarget: rootId.substring(0, 8),
      conversationId: this.conversationId
    });

    while (currentEvent) {
      iteration++;

      // Prevent infinite loops
      if (visitedIds.has(currentEvent.id)) {
        logger.warn("[THREAD_PATH] Circular reference detected", {
          eventId: currentEvent.id,
          conversationId: this.conversationId,
          iteration,
          visitedSoFar: Array.from(visitedIds).map(id => id.substring(0, 8))
        });
        break;
      }
      visitedIds.add(currentEvent.id);

      // Add to path (we'll reverse it later)
      path.unshift(currentEvent.id);

      logger.info("[THREAD_PATH] Added event to path", {
        iteration,
        eventId: currentEvent.id.substring(0, 8),
        eventKind: currentEvent.kind,
        pathLengthSoFar: path.length,
        conversationId: this.conversationId
      });

      // Check if we've reached the root
      if (currentEvent.id === rootId) {
        logger.info("[THREAD_PATH] Reached root event", {
          rootId: rootId.substring(0, 8),
          pathLength: path.length,
          iterations: iteration,
          conversationId: this.conversationId
        });
        break;
      }

      // Get parent via e tag
      const parentId = currentEvent.tagValue("e");
      logger.info("[THREAD_PATH] Looking for parent via e tag", {
        currentEventId: currentEvent.id.substring(0, 8),
        parentId: parentId?.substring(0, 8) || "none",
        conversationId: this.conversationId
      });

      if (!parentId) {
        // No parent, we're at a thread root (or orphaned)
        logger.info("[THREAD_PATH] No parent found - reached thread boundary", {
          currentEventId: currentEvent.id.substring(0, 8),
          pathLength: path.length,
          conversationId: this.conversationId
        });
        break;
      }

      // If parent is the root, add it and stop
      if (parentId === rootId) {
        path.unshift(rootId);
        logger.info("[THREAD_PATH] Parent is root - completing path", {
          parentId: parentId.substring(0, 8),
          rootId: rootId.substring(0, 8),
          finalPathLength: path.length,
          conversationId: this.conversationId
        });
        break;
      }

      // Move to parent
      currentEvent = eventMap.get(parentId);

      // If parent not in history, we have an incomplete thread
      if (!currentEvent) {
        logger.info("[THREAD_PATH] Parent event not in history - incomplete thread", {
          missingParentId: parentId.substring(0, 8),
          childId: path[0].substring(0, 8),
          conversationId: this.conversationId,
          pathSoFar: path.map(id => id.substring(0, 8))
        });
        // Try to at least include the root if we know about it
        if (eventMap.has(rootId)) {
          path.unshift(rootId);
          logger.info("[THREAD_PATH] Added known root to incomplete path", {
            rootId: rootId.substring(0, 8),
            finalPathLength: path.length,
            conversationId: this.conversationId
          });
        }
        break;
      }
    }

    logger.info("[THREAD_PATH] Thread path construction complete", {
      conversationId: this.conversationId,
      pathLength: path.length,
      iterations: iteration,
      threadPath: path.map(id => id.substring(0, 8)),
      fullPath: path
    });

    return path;
  }

  /**
   * Filter conversation history to only include events in the thread path
   */
  private getThreadEvents(
    history: NDKEvent[],
    triggeringEvent?: NDKEvent
  ): NDKEvent[] {
    logger.info("[THREAD_FILTER] Starting thread event filtering", {
      conversationId: this.conversationId,
      historySize: history.length,
      hasTriggeringEvent: !!triggeringEvent,
      triggeringEventId: triggeringEvent?.id.substring(0, 8),
      triggeringEventKind: triggeringEvent?.kind
    });

    // If no triggering event, return all history (root context)
    if (!triggeringEvent) {
      logger.info("[THREAD_FILTER] No triggering event - returning full history", {
        conversationId: this.conversationId,
        returningEventCount: history.length
      });
      return history;
    }

    // Get E and e tags to determine if this is a root or thread reply
    const rootTag = triggeringEvent.tagValue("E");
    const parentTag = triggeringEvent.tagValue("e");

    logger.info("[THREAD_FILTER] Analyzing event tags", {
      conversationId: this.conversationId,
      rootTag: rootTag?.substring(0, 8) || "none",
      parentTag: parentTag?.substring(0, 8) || "none",
      triggeringEventId: triggeringEvent.id.substring(0, 8)
    });

    // If no root tag, treat as root conversation
    if (!rootTag) {
      logger.info("[THREAD_FILTER] No root tag (E) - treating as root conversation", {
        conversationId: this.conversationId,
        returningEventCount: history.length
      });
      return history;
    }

    // Check if this is a reply to the root (E == e or e points to root)
    const rootEvent = history.find(e => e.id === rootTag);
    const isRootReply = parentTag === rootTag ||
                       (rootEvent && parentTag === rootEvent.id);

    logger.info("[THREAD_FILTER] Root reply check", {
      conversationId: this.conversationId,
      isRootReply,
      rootTag: rootTag.substring(0, 8),
      parentTag: parentTag?.substring(0, 8) || "none",
      rootEventFound: !!rootEvent,
      rootEventId: rootEvent?.id.substring(0, 8),
      condition: parentTag === rootTag ? "e==E" : rootEvent && parentTag === rootEvent.id ? "e==rootEvent.id" : "neither"
    });

    if (isRootReply) {
      // Root reply: include all chronological messages
      logger.info("[THREAD_FILTER] Root reply detected - using full history", {
        conversationId: this.conversationId,
        rootTag: rootTag.substring(0, 8),
        parentTag: parentTag?.substring(0, 8) || "none",
        returningEventCount: history.length
      });
      return history;
    }

    // Thread reply: build thread-specific path
    logger.info("[THREAD_FILTER] Thread reply detected - will filter to thread path", {
      conversationId: this.conversationId,
      rootTag: rootTag.substring(0, 8),
      parentTag: parentTag?.substring(0, 8) || "none",
      historyLength: history.length
    });

    // Find the parent event we're replying to
    const parentEvent = history.find(e => e.id === parentTag);
    logger.info("[THREAD_FILTER] Looking for parent event", {
      conversationId: this.conversationId,
      parentTag: parentTag?.substring(0, 8) || "none",
      parentEventFound: !!parentEvent,
      parentEventKind: parentEvent?.kind,
      parentEventContent: parentEvent?.content?.substring(0, 100)
    });

    if (!parentEvent) {
      logger.warn("[THREAD_FILTER] Parent event not found in history - falling back to full history", {
        parentTag: parentTag?.substring(0, 8) || "none",
        conversationId: this.conversationId,
        historyEventIds: history.map(e => e.id.substring(0, 8))
      });
      // Fall back to full history if we can't find the parent
      return history;
    }

    // Get the thread path
    logger.info("[THREAD_FILTER] Building thread path from parent event", {
      conversationId: this.conversationId,
      parentEventId: parentEvent.id.substring(0, 8)
    });
    const threadPath = this.getThreadPath(history, parentEvent);

    // Filter history to only include events in the thread path
    const threadEvents = history.filter(e => threadPath.includes(e.id));

    logger.info("[THREAD_FILTER] Thread filtering complete", {
      conversationId: this.conversationId,
      originalCount: history.length,
      filteredCount: threadEvents.length,
      threadPath: threadPath.map(id => id.substring(0, 8)),
      removedEvents: history
        .filter(e => !threadPath.includes(e.id))
        .map(e => ({
          id: e.id.substring(0, 8),
          kind: e.kind,
          content: e.content?.substring(0, 50)
        }))
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

    logger.info("[FILTER_TO_THREAD] Starting event filtering for thread", {
      conversationId: this.conversationId,
      eventsCount: events.length,
      triggeringEventId: triggeringEvent.id.substring(0, 8),
      rootTag: rootTag?.substring(0, 8) || "none",
      parentTag: parentTag?.substring(0, 8) || "none"
    });

    if (!rootTag) {
      logger.info("[FILTER_TO_THREAD] No root tag - returning all events", {
        conversationId: this.conversationId,
        returningEventCount: events.length
      });
      return events;
    }

    // Check if this is a root reply
    const isRootReply = parentTag === rootTag;
    logger.info("[FILTER_TO_THREAD] Checking if root reply", {
      conversationId: this.conversationId,
      isRootReply,
      condition: "e==E"
    });

    if (isRootReply) {
      logger.info("[FILTER_TO_THREAD] Root reply - returning all events", {
        conversationId: this.conversationId,
        returningEventCount: events.length
      });
      return events;
    }

    // Get the thread path from the full conversation history
    // We need this because missed events might not have all intermediate events
    logger.info("[FILTER_TO_THREAD] Building thread path for filtering", {
      conversationId: this.conversationId,
      note: "Using full event list as history may be incomplete"
    });
    const allEvents = [...events];
    const threadPath = this.getThreadPath(allEvents, triggeringEvent);

    // Filter to only events in the thread path
    const filteredEvents = events.filter(e => threadPath.includes(e.id));

    logger.info("[FILTER_TO_THREAD] Thread filtering complete", {
      conversationId: this.conversationId,
      originalCount: events.length,
      filteredCount: filteredEvents.length,
      threadPath: threadPath.map(id => id.substring(0, 8)),
      removedEvents: events
        .filter(e => !threadPath.includes(e.id))
        .map(e => ({
          id: e.id.substring(0, 8),
          kind: e.kind,
          content: e.content?.substring(0, 50)
        }))
    });

    return filteredEvents;
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
        undefined,
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
        undefined,
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
        undefined,
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
   * Build simple phase transition message (without instructions)
   * This is the simple format, different from the full transition with instructions
   */
  private buildSimplePhaseTransitionMessage(fromPhase: Phase | undefined, toPhase: Phase): string {
    return `=== CURRENT PHASE: ${toPhase.toUpperCase()} ===`;
  }
}
