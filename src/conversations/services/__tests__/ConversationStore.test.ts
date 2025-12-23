import { beforeEach, describe, expect, it } from "bun:test";
import { createMockNDKEvent } from "@/test-utils/bun-mocks";
import type { Conversation } from "../../types";
import { ConversationStore } from "../ConversationStore";

describe("ConversationStore", () => {
    let store: ConversationStore;
    let mockConversation: Conversation;

    beforeEach(() => {
        store = new ConversationStore();

        const mockEvent = createMockNDKEvent({
            id: "event1",
            content: "Test message",
            created_at: Math.floor(Date.now() / 1000),
        });

        mockConversation = {
            id: "conv1",
            title: "Test Conversation",
            phase: "CHAT",
            history: [mockEvent],
            agentStates: new Map(),
            agentTodos: new Map(),
            phaseStartedAt: Date.now(),
            metadata: {
                summary: "Test summary",
            },
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now(),
            },
        };
    });

    describe("get/set", () => {
        it("should store and retrieve a conversation", () => {
            store.set("conv1", mockConversation);
            const retrieved = store.get("conv1");
            expect(retrieved).toBe(mockConversation);
        });

        it("should return undefined for non-existent conversation", () => {
            const retrieved = store.get("nonexistent");
            expect(retrieved).toBeUndefined();
        });
    });

    describe("exists", () => {
        it("should return true for existing conversation", () => {
            store.set("conv1", mockConversation);
            expect(store.exists("conv1")).toBe(true);
        });

        it("should return false for non-existent conversation", () => {
            expect(store.exists("nonexistent")).toBe(false);
        });
    });

    describe("delete", () => {
        it("should delete a conversation", () => {
            store.set("conv1", mockConversation);
            expect(store.exists("conv1")).toBe(true);

            store.delete("conv1");
            expect(store.exists("conv1")).toBe(false);
        });
    });

    describe("getAll", () => {
        it("should return all conversations", () => {
            const conv2 = { ...mockConversation, id: "conv2", title: "Second Conversation" };

            store.set("conv1", mockConversation);
            store.set("conv2", conv2);

            const all = store.getAll();
            expect(all).toHaveLength(2);
            expect(all).toContain(mockConversation);
            expect(all).toContain(conv2);
        });

        it("should return empty array when no conversations", () => {
            const all = store.getAll();
            expect(all).toHaveLength(0);
        });
    });

    describe("findByEvent", () => {
        it("should find conversation containing specific event", () => {
            store.set("conv1", mockConversation);

            const found = store.findByEvent("event1");
            expect(found).toBe(mockConversation);
        });

        it("should return undefined if event not found", () => {
            store.set("conv1", mockConversation);

            const found = store.findByEvent("nonexistent");
            expect(found).toBeUndefined();
        });
    });

    describe("clear", () => {
        it("should clear all conversations", () => {
            store.set("conv1", mockConversation);
            store.set("conv2", { ...mockConversation, id: "conv2" });

            expect(store.size()).toBe(2);

            store.clear();
            expect(store.size()).toBe(0);
            expect(store.get("conv1")).toBeUndefined();
            expect(store.get("conv2")).toBeUndefined();
        });
    });

    describe("size", () => {
        it("should return the number of stored conversations", () => {
            expect(store.size()).toBe(0);

            store.set("conv1", mockConversation);
            expect(store.size()).toBe(1);

            store.set("conv2", { ...mockConversation, id: "conv2" });
            expect(store.size()).toBe(2);

            store.delete("conv1");
            expect(store.size()).toBe(1);
        });
    });
});
