import { EVENT_KINDS } from "@/llm/types";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import type { ProjectContext } from "@/services/ProjectContext";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { LLMOperationsRegistry } from "./LLMOperationsRegistry";

/**
 * OperationsStatusPublisher handles publishing of LLM operation status events to Nostr.
 * 
 * Publishes one event per event being processed, with:
 * - One e-tag for the event being processed
 * - P-tags for all agents working on that event
 * - One a-tag for the project reference
 */
export class OperationsStatusPublisher {
  private debounceTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private publishedEvents = new Set<string>(); // Track which events we've published status for
  private lastPublishedState = new Map<string, Set<string>>(); // Track which agents were published per event
  
  constructor(
    private registry: LLMOperationsRegistry,
    private debounceMs: number = 100
  ) {}
  
  start(): void {
    // Subscribe to registry changes
    this.unsubscribe = this.registry.onChange(() => {
      this.schedulePublish();
    });
    
    // Publish initial state if any operations exist
    this.publishNow().catch(err => {
      logger.error('[OperationsStatusPublisher] Failed to publish initial state', {
        error: formatAnyError(err)
      });
    });
  }
  
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }
  
  private schedulePublish(): void {
    // Clear existing timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    // Schedule new publish
    this.debounceTimer = setTimeout(() => {
      this.publishNow().catch(err => {
        logger.error('[OperationsStatusPublisher] Failed to publish status', {
          error: formatAnyError(err)
        });
      });
    }, this.debounceMs);
  }
  
  private async publishNow(): Promise<void> {
    if (!isProjectContextInitialized()) {
      logger.debug('[OperationsStatusPublisher] Project context not initialized, skipping publish');
      return;
    }
    
    const projectCtx = getProjectContext();
    const operationsByEvent = this.registry.getOperationsByEvent();
    
    // Keep track of currently active events
    const currentEventIds = new Set(operationsByEvent.keys());
    
    // Track events we need to clean up
    const eventsToCleanup = new Set<string>();
    
    // Check which previously published events are no longer active
    for (const eventId of this.publishedEvents) {
      if (!currentEventIds.has(eventId)) {
        eventsToCleanup.add(eventId);
      }
    }
    
    // Log current state for debugging
    if (operationsByEvent.size > 0 || eventsToCleanup.size > 0) {
      logger.debug('[OperationsStatusPublisher] Current state', {
        activeEvents: Array.from(currentEventIds).map(id => id.substring(0, 8)),
        previouslyPublished: Array.from(this.publishedEvents).map(id => id.substring(0, 8)),
        toCleanup: Array.from(eventsToCleanup).map(id => id.substring(0, 8))
      });
    }
    
    // Publish one 24133 event per event being processed
    for (const [eventId, operations] of operationsByEvent) {
      try {
        // Only publish if state changed or not previously published
        if (!this.publishedEvents.has(eventId) || this.hasOperationsChanged(eventId, operations)) {
          await this.publishEventStatus(eventId, operations, projectCtx);
          this.publishedEvents.add(eventId);
          this.lastPublishedState.set(eventId, new Set(operations.map(op => op.agentPubkey)));
        }
      } catch (err) {
        logger.error('[OperationsStatusPublisher] Failed to publish event status', {
          eventId: eventId.substring(0, 8),
          error: formatAnyError(err)
        });
      }
    }
    
    // Publish cleanup events (empty p-tags) for completed events
    for (const eventId of eventsToCleanup) {
      try {
        logger.debug('[OperationsStatusPublisher] Publishing cleanup event', {
          eventId: eventId.substring(0, 8)
        });
        await this.publishEventStatus(eventId, [], projectCtx);
        this.publishedEvents.delete(eventId);
        this.lastPublishedState.delete(eventId);
      } catch (err) {
        logger.error('[OperationsStatusPublisher] Failed to publish cleanup status', {
          eventId: eventId.substring(0, 8),
          error: formatAnyError(err)
        });
      }
    }
    
    logger.debug('[OperationsStatusPublisher] Published status', {
      activeEvents: operationsByEvent.size,
      cleanedEvents: eventsToCleanup.size,
      totalOperations: Array.from(operationsByEvent.values()).reduce((sum, ops) => sum + ops.length, 0)
    });
  }
  
  private hasOperationsChanged(eventId: string, operations: any[]): boolean {
    const lastState = this.lastPublishedState.get(eventId);
    if (!lastState) return true;
    
    const currentAgents = new Set(operations.map(op => op.agentPubkey));
    if (lastState.size !== currentAgents.size) return true;
    
    for (const agent of currentAgents) {
      if (!lastState.has(agent)) return true;
    }
    
    return false;
  }
  
  private async publishEventStatus(
    eventId: string, 
    operations: any[], // Using any to avoid circular dependency with LLMOperation type
    projectCtx: ProjectContext
  ): Promise<void> {
    const event = new NDKEvent(getNDK());
    event.kind = EVENT_KINDS.OPERATIONS_STATUS;
    event.content = "";
    
    // Single e-tag for the event being processed
    event.tag(["e", eventId]);
    
    // P-tags for all agents working on this event
    const agentPubkeys = new Set(operations.map(op => op.agentPubkey));
    for (const pubkey of agentPubkeys) {
      event.tag(["p", pubkey]);
    }
    
    // A-tag for the project
    event.tag(projectCtx.project.tagReference());
    
    // Sign with project signer and publish if available
    if (projectCtx.signer) {
      await event.sign(projectCtx.signer);
      await event.publish();
    } else {
      logger.warn("No project signer available, cannot publish operations status event");
      return;
    }
    
    const isCleanup = operations.length === 0;
    logger.info('[OperationsStatusPublisher] Published event status', {
      eventId: eventId.substring(0, 8),
      agentCount: agentPubkeys.size,
      operationCount: operations.length,
      type: isCleanup ? 'cleanup' : 'active',
      pTags: Array.from(agentPubkeys).map(p => p.substring(0, 8))
    });
  }
}