import { describe, it, expect } from "vitest";
import { ThreadService } from "../ThreadService";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("ThreadService", () => {
    const threadService = new ThreadService();

    // Helper to create mock events
    const createMockEvent = (id: string, parentId?: string): NDKEvent => ({
        id,
        pubkey: `user-${id}`,
        created_at: Date.now() / 1000,
        kind: 1,
        tags: parentId ? [['e', parentId]] : [],
        content: `Message ${id}`,
        sig: 'mock-sig',
        // Add the tagValue method that ThreadService needs
        tagValue: function(tagName: string): string | undefined {
            const tag = this.tags.find((t: string[]) => t[0] === tagName);
            return tag ? tag[1] : undefined;
        }
    } as NDKEvent);

    describe("getThreadToEvent", () => {
        it("should build a simple linear thread", () => {
            const event1 = createMockEvent("1");
            const event2 = createMockEvent("2", "1");
            const event3 = createMockEvent("3", "2");

            const history = [event1, event2, event3];

            const thread = threadService.getThreadToEvent("3", history);

            expect(thread).toHaveLength(3);
            expect(thread[0].id).toBe("1");
            expect(thread[1].id).toBe("2");
            expect(thread[2].id).toBe("3");
        });

        it("should handle event not found", () => {
            const event1 = createMockEvent("1");
            const history = [event1];

            const thread = threadService.getThreadToEvent("non-existent", history);

            expect(thread).toHaveLength(0);
        });

        it("should handle orphaned event (parent not in history)", () => {
            const event1 = createMockEvent("1");
            const event3 = createMockEvent("3", "2"); // Parent "2" not in history

            const history = [event1, event3];

            const thread = threadService.getThreadToEvent("3", history);

            expect(thread).toHaveLength(1);
            expect(thread[0].id).toBe("3");
        });

        it("should detect circular references", () => {
            // Create a circular reference: 1 -> 2 -> 3 -> 2
            const event1 = createMockEvent("1");
            const event2 = createMockEvent("2", "1");
            const event3 = createMockEvent("3", "2");

            // Modify event2 to point back to event3 (creating a cycle)
            event2.tags = [['e', '3']];

            const history = [event1, event2, event3];

            const thread = threadService.getThreadToEvent("3", history);

            // Should stop at the circular reference
            expect(thread.length).toBeGreaterThan(0);
            expect(thread.length).toBeLessThanOrEqual(3);
        });
    });

    describe("getChildEvents", () => {
        it("should find all direct children of an event", () => {
            const event1 = createMockEvent("1");
            const event2 = createMockEvent("2", "1");
            const event3 = createMockEvent("3", "1");
            const event4 = createMockEvent("4", "2");

            const history = [event1, event2, event3, event4];

            const children = threadService.getChildEvents("1", history);

            expect(children).toHaveLength(2);
            expect(children.map(e => e.id)).toContain("2");
            expect(children.map(e => e.id)).toContain("3");
            expect(children.map(e => e.id)).not.toContain("4");
        });

        it("should return empty array for events with no children", () => {
            const event1 = createMockEvent("1");
            const event2 = createMockEvent("2", "1");

            const history = [event1, event2];

            const children = threadService.getChildEvents("2", history);

            expect(children).toHaveLength(0);
        });
    });

    describe("getThreadRoot", () => {
        it("should return the first event ID as root", () => {
            const event1 = createMockEvent("1");
            const event2 = createMockEvent("2", "1");
            const event3 = createMockEvent("3", "2");

            const thread = [event1, event2, event3];

            const root = threadService.getThreadRoot(thread);

            expect(root).toBe("1");
        });

        it("should return 'unknown' for empty thread", () => {
            const root = threadService.getThreadRoot([]);

            expect(root).toBe("unknown");
        });
    });

    describe("isInThread", () => {
        it("should correctly identify if event is in a thread", () => {
            const event1 = createMockEvent("1");
            const event2 = createMockEvent("2", "1");
            const event3 = createMockEvent("3", "2");
            const event4 = createMockEvent("4");

            const history = [event1, event2, event3, event4];

            expect(threadService.isInThread("2", "1", history)).toBe(true);
            expect(threadService.isInThread("3", "1", history)).toBe(true);
            expect(threadService.isInThread("4", "1", history)).toBe(false);
        });
    });
});