import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { fetchConversation } from "../conversationFetcher";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock the services module before importing anything that uses it
const mockProjectContext = {
    project: {
        pubkey: "human-pubkey",
    },
    agents: new Map([
        ["test-agent", {
            name: "Test Agent",
            slug: "test-agent",
            pubkey: "agent-pubkey",
        }],
    ]),
};

mock.module("@/services", () => ({
    getProjectContext: () => mockProjectContext,
}));

describe("fetchConversation", () => {
    let mockNdk: NDK;
    let mockRootEvent: NDKEvent;
    let mockReplyEvent: NDKEvent;

    beforeEach(() => {
        // Create mock events
        mockRootEvent = new NDKEvent();
        mockRootEvent.id = "root-event-id";
        mockRootEvent.pubkey = "human-pubkey";
        mockRootEvent.created_at = 1234567890;
        mockRootEvent.content = "This is the root message";
        mockRootEvent.tags = [];

        mockReplyEvent = new NDKEvent();
        mockReplyEvent.id = "reply-event-id";
        mockReplyEvent.pubkey = "agent-pubkey";
        mockReplyEvent.created_at = 1234567900;
        mockReplyEvent.content = "This is a reply";
        mockReplyEvent.tags = [
            ["e", "root-event-id"],
            ["E", "root-event-id"],
        ];

        // Create mock NDK instance
        const mockUser = {
            fetchProfile: mock(() => Promise.resolve()),
            profile: {
                displayName: "Test User",
                name: "testuser",
            },
        };

        mockNdk = {
            fetchEvent: mock(() => Promise.resolve(mockRootEvent)),
            fetchEvents: mock(() => Promise.resolve(new Set([mockRootEvent, mockReplyEvent]))),
            getUser: mock(() => mockUser),
        } as unknown as NDK;
    });

    test("fetches and formats a simple conversation", async () => {
        const result = await fetchConversation("nevent1test", mockNdk, "/test/path");

        expect(result).toContain("# Conversation Thread");
        expect(result).toContain("This is the root message");
        expect(result).toContain("This is a reply");
        expect(mockNdk.fetchEvent).toHaveBeenCalledWith("nevent1test");
    });

    test("handles event not found", async () => {
        mockNdk.fetchEvent = mock(() => Promise.resolve(null));

        await expect(fetchConversation("nevent1notfound", mockNdk, "/test/path")).rejects.toThrow(
            "Event nevent1notfound not found"
        );
    });

    test("identifies human vs agent messages", async () => {
        const result = await fetchConversation("nevent1test", mockNdk, "/test/path");

        // The result should differentiate between human and agent
        // We can't test colors directly but we can verify the content is there
        expect(result).toContain("This is the root message"); // Human message
        expect(result).toContain("This is a reply"); // Agent message
    });

    test("handles events with E tag for root reference", async () => {
        mockRootEvent.tagValue = mock((tag: string) => {
            if (tag === "E") return "root-event-id";
            return null;
        });

        const result = await fetchConversation("nevent1test", mockNdk, "/test/path");

        expect(result).toBeDefined();
        expect(result).toContain("Conversation Thread");
    });

    test("sorts events by timestamp", async () => {
        const olderEvent = new NDKEvent();
        olderEvent.id = "older-event-id";
        olderEvent.pubkey = "another-pubkey";
        olderEvent.created_at = 1234567880; // Earlier timestamp
        olderEvent.content = "Earlier message";
        olderEvent.tags = [["E", "root-event-id"]];

        mockNdk.fetchEvents = mock(() => 
            Promise.resolve(new Set([mockReplyEvent, mockRootEvent, olderEvent]))
        );

        const result = await fetchConversation("nevent1test", mockNdk, "/test/path");

        // Verify events appear in chronological order
        const earlierIndex = result.indexOf("Earlier message");
        const rootIndex = result.indexOf("This is the root message");
        const replyIndex = result.indexOf("This is a reply");

        expect(earlierIndex).toBeLessThan(rootIndex);
        expect(rootIndex).toBeLessThan(replyIndex);
    });

    test("handles missing profile information gracefully", async () => {
        const mockUserWithoutProfile = {
            fetchProfile: mock(() => Promise.reject(new Error("Profile not found"))),
            profile: null,
        };

        mockNdk.getUser = mock(() => mockUserWithoutProfile);

        const unknownEvent = new NDKEvent();
        unknownEvent.id = "unknown-event-id";
        unknownEvent.pubkey = "unknown-pubkey";
        unknownEvent.created_at = 1234567895;
        unknownEvent.content = "Message from unknown user";
        unknownEvent.tags = [["E", "root-event-id"]];

        mockNdk.fetchEvents = mock(() =>
            Promise.resolve(new Set([mockRootEvent, unknownEvent]))
        );

        const result = await fetchConversation("nevent1test", mockNdk, "/test/path");

        expect(result).toContain("Message from unknown user");
        // Should show truncated pubkey when profile fetch fails
        expect(result).toMatch(/@unknown-.../);
    });

    test("builds conversation tree with nested replies", async () => {
        const nestedReply = new NDKEvent();
        nestedReply.id = "nested-reply-id";
        nestedReply.pubkey = "human-pubkey";
        nestedReply.created_at = 1234567910;
        nestedReply.content = "Nested reply to agent";
        nestedReply.tags = [
            ["e", "reply-event-id"],
            ["E", "root-event-id"],
        ];

        mockNdk.fetchEvents = mock(() =>
            Promise.resolve(new Set([mockRootEvent, mockReplyEvent, nestedReply]))
        );

        const result = await fetchConversation("nevent1test", mockNdk, "/test/path");

        expect(result).toContain("This is the root message");
        expect(result).toContain("This is a reply");
        expect(result).toContain("Nested reply to agent");
    });
});