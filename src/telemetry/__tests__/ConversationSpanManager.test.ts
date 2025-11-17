import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createMockNDKEvent } from "@/test-utils/mock-factories";
import { ConversationSpanManager, getConversationSpanManager, resetConversationSpanManager } from "../ConversationSpanManager";
import type { Span } from "@opentelemetry/api";

describe("ConversationSpanManager", () => {
    let manager: ConversationSpanManager;
    let mockSpan: Span;

    beforeEach(() => {
        // Reset singleton before each test
        resetConversationSpanManager();
        manager = getConversationSpanManager();

        // Create a mock span
        mockSpan = {
            setAttributes: mock(() => {}),
            setAttribute: mock(() => {}),
            addEvent: mock(() => {}),
            setStatus: mock(() => {}),
            updateName: mock(() => {}),
            end: mock(() => {}),
            isRecording: () => true,
            recordException: mock(() => {}),
            spanContext: () => ({
                traceId: "test-trace-id",
                spanId: "test-span-id",
                traceFlags: 0,
            }),
        } as any;
    });

    afterEach(() => {
        manager.shutdown();
    });

    it("should increment message count and set span attributes", () => {
        const conversationId = "conversation_root_123";

        manager.incrementMessageCount(conversationId, mockSpan);

        // Check that attributes were set on the span
        expect(mockSpan.setAttributes).toHaveBeenCalledWith({
            "conversation.message_sequence": 1,
        });

        // Check message count
        expect(manager.getMessageCount(conversationId)).toBe(1);

        // Check stats
        const stats = manager.getStats();
        expect(stats.trackedConversations).toBe(1);
        expect(stats.totalMessages).toBe(1);
    });

    it("should track multiple messages in same conversation", () => {
        const conversationId = "conversation_root_123";

        // Add first message
        manager.incrementMessageCount(conversationId, mockSpan);
        expect(manager.getMessageCount(conversationId)).toBe(1);

        // Add second message
        manager.incrementMessageCount(conversationId, mockSpan);
        expect(manager.getMessageCount(conversationId)).toBe(2);

        // Check that second call set correct sequence number
        expect(mockSpan.setAttributes).toHaveBeenCalledWith({
            "conversation.message_sequence": 2,
        });

        const stats = manager.getStats();
        expect(stats.trackedConversations).toBe(1);
        expect(stats.totalMessages).toBe(2);
    });

    it("should track multiple conversations separately", () => {
        const conversationA = "conversation_A";
        const conversationB = "conversation_B";

        manager.incrementMessageCount(conversationA, mockSpan);
        manager.incrementMessageCount(conversationB, mockSpan);
        manager.incrementMessageCount(conversationA, mockSpan);

        expect(manager.getMessageCount(conversationA)).toBe(2);
        expect(manager.getMessageCount(conversationB)).toBe(1);

        const stats = manager.getStats();
        expect(stats.trackedConversations).toBe(2);
        expect(stats.totalMessages).toBe(3);
    });

    it("should return 0 for unknown conversation", () => {
        expect(manager.getMessageCount("unknown_conversation")).toBe(0);

        const stats = manager.getStats();
        expect(stats.trackedConversations).toBe(0);
        expect(stats.totalMessages).toBe(0);
    });

    it("should handle shutdown gracefully", () => {
        const conversationA = "conversation_A";
        const conversationB = "conversation_B";

        manager.incrementMessageCount(conversationA, mockSpan);
        manager.incrementMessageCount(conversationB, mockSpan);

        let stats = manager.getStats();
        expect(stats.trackedConversations).toBe(2);
        expect(stats.totalMessages).toBe(2);

        manager.shutdown();

        stats = manager.getStats();
        expect(stats.trackedConversations).toBe(0);
        expect(stats.totalMessages).toBe(0);
    });

    it("should handle singleton pattern correctly", () => {
        const manager1 = getConversationSpanManager();
        const manager2 = getConversationSpanManager();

        expect(manager1).toBe(manager2);

        manager1.incrementMessageCount("test", mockSpan);
        expect(manager2.getMessageCount("test")).toBe(1);
    });

    it("should reset singleton properly", () => {
        const manager1 = getConversationSpanManager();
        manager1.incrementMessageCount("test", mockSpan);
        expect(manager1.getMessageCount("test")).toBe(1);

        resetConversationSpanManager();

        const manager2 = getConversationSpanManager();
        expect(manager2).not.toBe(manager1);
        expect(manager2.getMessageCount("test")).toBe(0);
    });
});