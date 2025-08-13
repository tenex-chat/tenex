import { NDKEvent, NDKSigner } from '@nostr-dev-kit/ndk';
import { getNDK } from './index';
import { logger } from '@/utils/logger';

/**
 * Service for handling Nostr event operations including signing and publishing.
 * This centralizes event management for the execution queue system.
 */
export class NostrEventService {
  private signer?: NDKSigner;

  constructor(signer?: NDKSigner) {
    this.signer = signer;
  }

  setSigner(signer: NDKSigner): void {
    this.signer = signer;
  }

  /**
   * Signs and publishes an NDKEvent to the Nostr network
   */
  async signAndPublishEvent(event: NDKEvent): Promise<void> {
    if (!this.signer) {
      throw new Error('No signer available for NostrEventService');
    }

    try {
      // Sign the event
      await event.sign(this.signer);

      // Publish to the network
      await event.publish();

      logger.debug('Published Nostr event', {
        kind: event.kind,
        id: event.id,
        tags: event.tags
      });
    } catch (error) {
      logger.error('Failed to sign and publish event', {
        kind: event.kind,
        error
      });
      throw error;
    }
  }

  /**
   * Publishes an event without signing (assumes already signed)
   */
  async publishEvent(event: NDKEvent): Promise<void> {
    try {
      await event.publish();

      logger.debug('Published pre-signed Nostr event', {
        kind: event.kind,
        id: event.id
      });
    } catch (error) {
      logger.error('Failed to publish event', {
        kind: event.kind,
        error
      });
      throw error;
    }
  }

  /**
   * Creates and configures an NDKEvent with proper NDK instance
   */
  createEvent(kind: number): NDKEvent {
    const ndk = getNDK();
    const event = new NDKEvent(ndk);
    event.kind = kind;
    event.created_at = Math.floor(Date.now() / 1000);
    return event;
  }

  /**
   * Fetches events from the network based on filters
   */
  async fetchEvents(filter: any): Promise<Set<NDKEvent>> {
    const ndk = getNDK();
    return await ndk.fetchEvents(filter);
  }

  /**
   * Subscribes to events matching the given filter
   */
  subscribe(filter: any, callbacks: {
    onEvent?: (event: NDKEvent) => void;
    onEose?: () => void;
  }) {
    const ndk = getNDK();
    const subscription = ndk.subscribe(filter);

    if (callbacks.onEvent) {
      subscription.on('event', callbacks.onEvent);
    }

    if (callbacks.onEose) {
      subscription.on('eose', callbacks.onEose);
    }

    return subscription;
  }
}