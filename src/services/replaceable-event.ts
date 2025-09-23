import type { NDK, NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";

/**
 * Generic service for managing replaceable Nostr events.
 * Handles fetching, updating tags, and publishing replaceable events.
 * Follows clean architecture principles with single responsibility.
 */
export class ReplaceableEventService {
  private tags: string[][] = [];
  private pubkey: string;
  private signer: NDKPrivateKeySigner;

  /**
   * Creates a new ReplaceableEventService
   * @param ndk - NDK instance for Nostr operations
   * @param privateKey - Hex private key for signing events
   * @param kind - Event kind (must be a replaceable event kind)
   */
  constructor(
    private ndk: NDK,
    privateKey: string,
    private kind: number
  ) {
    this.signer = new NDKPrivateKeySigner(privateKey);
    this.pubkey = this.signer.pubkey;
  }

  /**
   * Initialize the service by fetching the latest event from relays
   */
  async initialize(): Promise<void> {
    try {
      // Fetch the latest event with precise filter
      const filter = {
        kinds: [this.kind],
        authors: [this.pubkey],
        limit: 1
      };

      const events = await this.ndk.fetchEvents(filter);
      
      if (events.size > 0) {
        // Get the first (and should be only) event
        const event = Array.from(events)[0];
        this.tags = event.tags;
        logger.debug(`Loaded existing event kind ${this.kind} with ${this.tags.length} tags`);
      } else {
        logger.debug(`No existing event kind ${this.kind} found, starting fresh`);
      }
    } catch (error) {
      logger.error(`Failed to initialize ReplaceableEventService for kind ${this.kind}`, error);
      throw error;
    }
  }

  /**
   * Add a tag to the event if it doesn't already exist
   * @param tag - The tag array to add
   * @returns true if tag was added, false if it already existed
   */
  addTag(tag: string[]): boolean {
    // Check if tag already exists
    const exists = this.tags.some(existingTag => 
      existingTag.length === tag.length &&
      existingTag.every((val, idx) => val === tag[idx])
    );

    if (!exists) {
      this.tags.push(tag);
      logger.debug(`Added tag to kind ${this.kind}: ${JSON.stringify(tag)}`);
      return true;
    }

    logger.debug(`Tag already exists in kind ${this.kind}: ${JSON.stringify(tag)}`);
    return false;
  }

  /**
   * Remove a tag from the event if it exists
   * @param tag - The tag array to remove
   * @returns true if tag was removed, false if it didn't exist
   */
  removeTag(tag: string[]): boolean {
    const initialLength = this.tags.length;
    this.tags = this.tags.filter(existingTag => 
      !(existingTag.length === tag.length &&
        existingTag.every((val, idx) => val === tag[idx]))
    );
    
    const removed = this.tags.length < initialLength;
    if (removed) {
      logger.debug(`Removed tag from kind ${this.kind}: ${JSON.stringify(tag)}`);
    }
    return removed;
  }

  /**
   * Get all current tags
   */
  getTags(): string[][] {
    return [...this.tags]; // Return a copy to maintain immutability
  }

  /**
   * Check if a tag exists
   */
  hasTag(tag: string[]): boolean {
    return this.tags.some(existingTag => 
      existingTag.length === tag.length &&
      existingTag.every((val, idx) => val === tag[idx])
    );
  }

  /**
   * Publish the current state of the event to Nostr
   */
  async publish(): Promise<void> {
    try {
      const event = this.ndk.createEvent({
        kind: this.kind,
        content: "",
        tags: this.tags,
        pubkey: this.pubkey,
        created_at: Math.floor(Date.now() / 1000)
      });

      // Sign the event
      await event.sign(this.signer);

      // Publish to relays
      await event.publish();

      logger.info(`Published replaceable event kind ${this.kind} with ${this.tags.length} tags`);
    } catch (error) {
      logger.error(`Failed to publish replaceable event kind ${this.kind}`, error);
      throw error;
    }
  }

  /**
   * Get the public key of the service
   */
  getPubkey(): string {
    return this.pubkey;
  }
}