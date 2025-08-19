import { NDKEvent } from "@nostr-dev-kit/ndk";
import { getNDK } from "./ndkClient";

/**
 * Create an NDK event with standard fields
 */
export function createNDKEvent(
    kind: number,
    content: string,
    pubkey?: string,
    tags: string[][] = []
): NDKEvent {
    const event = new NDKEvent(getNDK());
    event.kind = kind;
    event.content = content;
    event.tags = tags;
    event.created_at = Math.floor(Date.now() / 1000);
    
    if (pubkey) {
        event.pubkey = pubkey;
    }
    
    return event;
}

/**
 * Add tags to an existing event
 */
export function addTagsToEvent(event: NDKEvent, tags: string[][]): void {
    event.tags = [...(event.tags || []), ...tags];
}

/**
 * Set event timestamp to current time
 */
export function setEventTimestamp(event: NDKEvent): void {
    event.created_at = Math.floor(Date.now() / 1000);
}