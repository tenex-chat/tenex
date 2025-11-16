import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMockNDKEvent } from "@/test-utils/mock-factories";
import { ConversationSpanManager } from "../ConversationSpanManager";

describe("ConversationSpanManager", () => {
    let manager: ConversationSpanManager;

    beforeEach(() => {
        manager = new ConversationSpanManager();
    });

    afterEach(() => {
        manager.shutdown();
    });

    it("should create a conversation span for events with conversation root", () => {
        const mockEvent = createMockNDKEvent({
            id: "event1",
            kind: 11,
            pubkey: "user1",
            tags: [["E", "conversation_root_123"]],
            content: "Hello",
        });

        const span = manager.getOrCreateConversationSpan(mockEvent);
        expect(span).not.toBeNull();

        const stats = manager.getStats();
        expect(stats.activeConversations).toBe(1);
        expect(stats.totalMessages).toBe(1);
    });

    it("should return null for events without conversation root", () => {
        const mockEvent = createMockNDKEvent({
            id: "event1",
            kind: 11,
            pubkey: "user1",
            tags: [],
            content: "Hello",
        });

        const span = manager.getOrCreateConversationSpan(mockEvent);
        expect(span).toBeNull();

        const stats = manager.getStats();
        expect(stats.activeConversations).toBe(0);
    });

    it("should reuse existing conversation span for multiple messages", () => {
        const conversationRoot = "conversation_root_123";

        const event1 = createMockNDKEvent({
            id: "event1",
            kind: 11,
            pubkey: "user1",
            tags: [["E", conversationRoot]],
            content: "Message 1",
        });

        const event2 = createMockNDKEvent({
            id: "event2",
            kind: 11,
            pubkey: "user2",
            tags: [["E", conversationRoot]],
            content: "Message 2",
        });

        const span1 = manager.getOrCreateConversationSpan(event1);
        const span2 = manager.getOrCreateConversationSpan(event2);

        // Should return the same span
        expect(span1).toBe(span2);

        const stats = manager.getStats();
        expect(stats.activeConversations).toBe(1);
        expect(stats.totalMessages).toBe(2);
    });

    it("should create separate spans for different conversations", () => {
        const event1 = createMockNDKEvent({
            id: "event1",
            kind: 11,
            pubkey: "user1",
            tags: [["E", "conversation_A"]],
            content: "Message A",
        });

        const event2 = createMockNDKEvent({
            id: "event2",
            kind: 11,
            pubkey: "user2",
            tags: [["E", "conversation_B"]],
            content: "Message B",
        });

        const span1 = manager.getOrCreateConversationSpan(event1);
        const span2 = manager.getOrCreateConversationSpan(event2);

        // Should be different spans
        expect(span1).not.toBe(span2);

        const stats = manager.getStats();
        expect(stats.activeConversations).toBe(2);
        expect(stats.totalMessages).toBe(2);
    });

    it("should finalize conversations", () => {
        const mockEvent = createMockNDKEvent({
            id: "event1",
            kind: 11,
            pubkey: "user1",
            tags: [["E", "conversation_root_123"]],
            content: "Hello",
        });

        manager.getOrCreateConversationSpan(mockEvent);

        let stats = manager.getStats();
        expect(stats.activeConversations).toBe(1);

        manager.finalizeConversation("conversation_root_123");

        stats = manager.getStats();
        expect(stats.activeConversations).toBe(0);
    });

    it("should handle shutdown gracefully", () => {
        const event1 = createMockNDKEvent({
            id: "event1",
            kind: 11,
            pubkey: "user1",
            tags: [["E", "conversation_A"]],
            content: "Message A",
        });

        const event2 = createMockNDKEvent({
            id: "event2",
            kind: 11,
            pubkey: "user2",
            tags: [["E", "conversation_B"]],
            content: "Message B",
        });

        manager.getOrCreateConversationSpan(event1);
        manager.getOrCreateConversationSpan(event2);

        let stats = manager.getStats();
        expect(stats.activeConversations).toBe(2);

        manager.shutdown();

        stats = manager.getStats();
        expect(stats.activeConversations).toBe(0);
    });

    it("should support both E and A tags for conversation root", () => {
        const eventWithE = createMockNDKEvent({
            id: "event1",
            kind: 11,
            pubkey: "user1",
            tags: [["E", "conversation_E"]],
            content: "Message E",
        });

        const eventWithA = createMockNDKEvent({
            id: "event2",
            kind: 11,
            pubkey: "user2",
            tags: [["A", "conversation_A"]],
            content: "Message A",
        });

        const span1 = manager.getOrCreateConversationSpan(eventWithE);
        const span2 = manager.getOrCreateConversationSpan(eventWithA);

        expect(span1).not.toBeNull();
        expect(span2).not.toBeNull();
        expect(span1).not.toBe(span2);

        const stats = manager.getStats();
        expect(stats.activeConversations).toBe(2);
    });
});
