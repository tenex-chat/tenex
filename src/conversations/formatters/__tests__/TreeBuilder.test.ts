import { NDKEvent } from "@nostr-dev-kit/ndk";
import { describe, expect, it, mock } from "bun:test";
import { TreeBuilder } from "../utils/TreeBuilder";

// Mock the PubkeyNameRepository to avoid NDK initialization
mock.module("@/services/PubkeyService", () => ({
    getPubkeyNameRepository: () => ({
        getName: mock((pubkey: string) => pubkey), // Just return pubkey as name
    }),
}));

describe("TreeBuilder", () => {
    const builder = new TreeBuilder();

    function createMockEvent(
        id: string,
        content: string,
        pubkey: string,
        tags: string[][] = [],
        timestamp: number = Date.now() / 1000
    ): NDKEvent {
        const event = new NDKEvent();
        event.id = id;
        event.content = content;
        event.pubkey = pubkey;
        event.created_at = timestamp;
        event.tags = tags;
        return event;
    }

    describe("parent-child relationship detection", () => {
        it("should detect single e tag as parent", async () => {
            const events = [
                createMockEvent("parent", "Parent message", "user1"),
                createMockEvent("child", "Child message", "user2", [["e", "parent"]]),
            ];

            const tree = await builder.buildFromEvents(events);

            expect(tree).toHaveLength(1);
            expect(tree[0].event.id).toBe("parent");
            expect(tree[0].children).toHaveLength(1);
            expect(tree[0].children[0].event.id).toBe("child");
        });

        it("should use reply marker when present", async () => {
            const events = [
                createMockEvent("root", "Root", "user1"),
                createMockEvent("parent", "Parent", "user2", [["e", "root"]]),
                createMockEvent("child", "Child", "user3", [
                    ["e", "root", "", "root"],
                    ["e", "parent", "", "reply"],
                ]),
            ];

            const tree = await builder.buildFromEvents(events);

            expect(tree).toHaveLength(1);
            expect(tree[0].event.id).toBe("root");
            expect(tree[0].children).toHaveLength(1);
            expect(tree[0].children[0].event.id).toBe("parent");
            expect(tree[0].children[0].children).toHaveLength(1);
            expect(tree[0].children[0].children[0].event.id).toBe("child");
        });

        it("should use last e tag as parent when no reply marker", async () => {
            const events = [
                createMockEvent("root", "Root", "user1"),
                createMockEvent("middle", "Middle", "user2", [["e", "root"]]),
                createMockEvent("child", "Child", "user3", [
                    ["e", "root"],
                    ["e", "middle"],
                ]),
            ];

            const tree = await builder.buildFromEvents(events);

            expect(tree).toHaveLength(1);
            const middleNode = tree[0].children[0];
            expect(middleNode.event.id).toBe("middle");
            expect(middleNode.children).toHaveLength(1);
            expect(middleNode.children[0].event.id).toBe("child");
        });
    });

    // Agent name extraction tests removed - implementation now uses PubkeyNameRepository
    // instead of extracting from tags/content patterns

    describe("tool call extraction", () => {
        it("should extract from tool tag", async () => {
            const events = [
                createMockEvent("1", "Reading file", "agent", [
                    ["tool", "read_file", "config.json"],
                ]),
            ];

            const tree = await builder.buildFromEvents(events);

            expect(tree[0].toolCall).toEqual({
                name: "read_file",
                args: "config.json",
            });
        });

        it("should extract from content pattern", async () => {
            const events = [createMockEvent("1", 'Now calling tool: grep("pattern")', "agent")];

            const tree = await builder.buildFromEvents(events);

            expect(tree[0].toolCall).toEqual({
                name: "grep",
                args: '"pattern"',
            });
        });

        it("should handle tool calls without args", async () => {
            const events = [createMockEvent("1", "Executing: list_files", "agent")];

            const tree = await builder.buildFromEvents(events);

            expect(tree[0].toolCall).toEqual({
                name: "list_files",
                args: undefined,
            });
        });
    });

    describe("depth calculation", () => {
        it("should calculate correct depths", async () => {
            const events = [
                createMockEvent("1", "Depth 0", "user1"),
                createMockEvent("2", "Depth 1", "user2", [["e", "1"]]),
                createMockEvent("3", "Depth 2", "user3", [["e", "2"]]),
                createMockEvent("4", "Depth 3", "user4", [["e", "3"]]),
            ];

            const tree = await builder.buildFromEvents(events);

            expect(tree[0].depth).toBe(0);
            expect(tree[0].children[0].depth).toBe(1);
            expect(tree[0].children[0].children[0].depth).toBe(2);
            expect(tree[0].children[0].children[0].children[0].depth).toBe(3);
        });
    });

    describe("sorting", () => {
        it("should sort children by timestamp", async () => {
            const events = [
                createMockEvent("root", "Root", "user1", [], 1000),
                createMockEvent("child3", "Third", "user2", [["e", "root"]], 1003),
                createMockEvent("child1", "First", "user3", [["e", "root"]], 1001),
                createMockEvent("child2", "Second", "user4", [["e", "root"]], 1002),
            ];

            const tree = await builder.buildFromEvents(events);

            expect(tree[0].children).toHaveLength(3);
            expect(tree[0].children[0].event.id).toBe("child1");
            expect(tree[0].children[1].event.id).toBe("child2");
            expect(tree[0].children[2].event.id).toBe("child3");
        });

        it("should sort root nodes by timestamp", async () => {
            const events = [
                createMockEvent("root2", "Second root", "user1", [], 1002),
                createMockEvent("root1", "First root", "user2", [], 1001),
                createMockEvent("root3", "Third root", "user3", [], 1003),
            ];

            const tree = await builder.buildFromEvents(events);

            expect(tree).toHaveLength(3);
            expect(tree[0].event.id).toBe("root1");
            expect(tree[1].event.id).toBe("root2");
            expect(tree[2].event.id).toBe("root3");
        });
    });
});
