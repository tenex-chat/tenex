import { NDKEvent } from '@nostr-dev-kit/ndk';
import { ExecutionLock, QueueEntry, ForceReleaseRequest } from './types';
import { NostrEventService } from '../../nostr/NostrEventService';
import { EVENT_KINDS } from '../../llm/types';

export class ExecutionEventPublisher {
  constructor(
    private nostrService: NostrEventService,
    private projectPubkey: string,
    private projectIdentifier: string
  ) {}

  async publishStatusUpdate(
    currentLock: ExecutionLock | null,
    queue: QueueEntry[],
    estimatedWait: number
  ): Promise<void> {
    try {
      const event = new NDKEvent();
      event.kind = EVENT_KINDS.PROJECT_STATUS;
      event.content = ''; // No JSON - keeping empty as per specification
      event.pubkey = this.projectPubkey;
      event.created_at = Math.floor(Date.now() / 1000);

      // Build tags
      const tags: string[][] = [];

      // Project reference tag
      tags.push(['a', `30001:${this.projectPubkey}:${this.projectIdentifier}`]);

      // Add execution-queue tags in order (preserving queue order)
      // First: the active/executing conversation (if any)
      if (currentLock) {
        tags.push([
          'execution-queue',
          currentLock.conversationId,
          'active'
        ]);
      }

      // Then: all waiting conversations in queue order
      for (const entry of queue) {
        tags.push([
          'execution-queue',
          entry.conversationId
        ]);
      }

      // Add supplementary metadata tags (not part of core queue representation)
      if (currentLock) {
        tags.push([
          'execution-metadata',
          'lock-timestamp',
          currentLock.timestamp.toString()
        ]);
        tags.push([
          'execution-metadata',
          'lock-agent',
          currentLock.agentPubkey
        ]);
      }

      tags.push([
        'execution-metadata',
        'queue-size',
        queue.length.toString()
      ]);
      
      tags.push([
        'execution-metadata',
        'estimated-wait',
        Math.floor(estimatedWait).toString()
      ]);

      event.tags = tags;

      // Sign and publish
      await this.nostrService.signAndPublishEvent(event);
    } catch (error) {
      console.error('Failed to publish execution status update:', error);
      // Don't throw - status updates are non-critical
    }
  }

  async publishForceReleaseEvent(request: ForceReleaseRequest): Promise<void> {
    try {
      const event = new NDKEvent();
      event.kind = EVENT_KINDS.FORCE_RELEASE; // 24019
      event.content = request.reason; // Simple human-readable reason, no JSON
      event.pubkey = request.releasedBy;
      event.created_at = Math.floor(Date.now() / 1000);

      // Build tags
      const tags: string[][] = [];

      // Project reference tag
      tags.push(['a', `30001:${this.projectPubkey}:${this.projectIdentifier}`]);

      // Force release details as individual tags
      tags.push(['force-release', request.conversationId]);
      tags.push(['force-release-reason', request.reason]);
      tags.push(['force-release-timestamp', request.timestamp.toString()]);
      tags.push(['released-by', request.releasedBy]);

      event.tags = tags;

      // Sign and publish
      await this.nostrService.signAndPublishEvent(event);
    } catch (error) {
      console.error('Failed to publish force release event:', error);
      // Don't throw - event publishing is non-critical
    }
  }

  async publishQueueEvent(
    type: 'lock_acquired' | 'lock_released' | 'queue_joined' | 'queue_left',
    conversationId: string,
    agentPubkey?: string,
    details?: Record<string, any>
  ): Promise<void> {
    try {
      const event = new NDKEvent();
      event.kind = EVENT_KINDS.PROJECT_STATUS;
      event.content = ''; // No JSON - empty as per specification
      event.pubkey = this.projectPubkey;
      event.created_at = Math.floor(Date.now() / 1000);

      // Build tags
      const tags: string[][] = [];

      // Project reference tag
      tags.push(['a', `30001:${this.projectPubkey}:${this.projectIdentifier}`]);

      // Queue event type with conversation ID
      tags.push(['queue-event', type, conversationId]);

      if (agentPubkey) {
        tags.push(['agent', agentPubkey]);
      }

      // Add any additional details as individual tags (no JSON)
      if (details) {
        for (const [key, value] of Object.entries(details)) {
          tags.push(['queue-event-detail', key, String(value)]);
        }
      }

      event.tags = tags;

      // Sign and publish
      await this.nostrService.signAndPublishEvent(event);
    } catch (error) {
      console.error(`Failed to publish queue event ${type}:`, error);
      // Don't throw - event publishing is non-critical
    }
  }

  async publishTimeoutWarning(
    conversationId: string,
    remainingMs: number
  ): Promise<void> {
    try {
      const event = new NDKEvent();
      event.kind = EVENT_KINDS.PROJECT_STATUS;
      event.content = ''; // No content - data in tags only
      event.pubkey = this.projectPubkey;
      event.created_at = Math.floor(Date.now() / 1000);

      // Build tags
      const tags: string[][] = [];

      // Project reference tag
      tags.push(['a', `30001:${this.projectPubkey}:${this.projectIdentifier}`]);

      // Timeout warning as structured tags
      tags.push(['timeout-warning', conversationId]);
      tags.push(['timeout-remaining-ms', remainingMs.toString()]);
      tags.push(['timeout-remaining-seconds', Math.floor(remainingMs / 1000).toString()]);

      event.tags = tags;

      // Sign and publish
      await this.nostrService.signAndPublishEvent(event);
    } catch (error) {
      console.error('Failed to publish timeout warning:', error);
      // Don't throw - warnings are non-critical
    }
  }
}