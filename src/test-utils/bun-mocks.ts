import { mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Create a mock NDKEvent for testing
 */
export function createMockNDKEvent(overrides: Partial<NDKEvent> = {}): NDKEvent {
    const event = {
        id: "test-event-id",
        kind: 1,
        pubkey: "test-pubkey",
        created_at: Math.floor(Date.now() / 1000),
        content: "test content",
        tags: [],
        sig: "test-sig",
        relay: undefined,
        tag: mock((tag: string[]): void => {
            (event as NDKEvent).tags.push(tag);
        }),
        tagValue: mock((tagName: string): string | undefined => {
            const tag = (event as NDKEvent).tags.find((t: string[]) => t[0] === tagName);
            return tag ? tag[1] : undefined;
        }),
        getMatchingTags: mock((tagName: string): string[][] => {
            return (event as NDKEvent).tags.filter((t: string[]) => t[0] === tagName);
        }),
        tagReference: mock((): string[] => ["e", "test-event-id"]),
        publish: mock((): Promise<void> => Promise.resolve()),
        reply: mock((): NDKEvent => {
            const replyEvent = createMockNDKEvent();
            replyEvent.tags = [["e", "test-event-id", "", "reply"]];
            return replyEvent;
        }),
        ...overrides,
    };

    // Override tags if provided
    if (overrides.tags) {
        event.tags = overrides.tags;
    }

    return event as unknown as NDKEvent;
}
