import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { ConversationStore } from "@/conversations/ConversationStore";
import { resolveCompletionRecipient, createEventContext } from "../EventContextService";
import type { ToolExecutionContext } from "@/tools/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock logger to avoid noise during tests
mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

/**
 * EventContextService Tests
 *
 * These tests verify the completionRecipientPubkey resolution logic in EventContextService.
 * The resolution ensures that completion events route back to the immediate delegator
 * even when RAL state is lost or the triggering event is from a different source.
 */
describe("EventContextService", () => {
    const TEST_DIR = "/tmp/tenex-event-context-service-test";

    // Test pubkeys (64-char hex format)
    const USER_PUBKEY = "user-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const ARCHITECT_PUBKEY = "arch-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd";
    const EXEC_COORD_PUBKEY = "exec-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd";
    const CLAUDE_CODE_PUBKEY = "claude-pubkey-234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        ConversationStore.initialize(TEST_DIR);
    });

    afterEach(async () => {
        ConversationStore.reset();
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    describe("resolveCompletionRecipient", () => {
        it("should return undefined when conversationStore is undefined", () => {
            const result = resolveCompletionRecipient(undefined);
            expect(result).toBeUndefined();
        });

        it("should return undefined when delegation chain is missing", async () => {
            const conversationId = "conv-no-chain";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Hello",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            await store.save();

            const result = resolveCompletionRecipient(store);
            expect(result).toBeUndefined();
        });

        it("should return undefined when delegation chain has only one entry", async () => {
            const conversationId = "conv-single-entry";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Hello",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false },
                ],
            });
            await store.save();

            const result = resolveCompletionRecipient(store);
            expect(result).toBeUndefined();
        });

        it("should resolve immediate delegator from 2-entry chain", async () => {
            const conversationId = "conv-2-entry";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: EXEC_COORD_PUBKEY,
                content: "Task",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "exec-coord", isUser: false },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false },
                ],
            });
            await store.save();

            const result = resolveCompletionRecipient(store);
            expect(result).toBe(EXEC_COORD_PUBKEY);
        });

        it("should resolve immediate delegator from 4-entry chain", async () => {
            const conversationId = "conv-4-entry";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: EXEC_COORD_PUBKEY,
                content: "Task",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                    { pubkey: ARCHITECT_PUBKEY, displayName: "architect", isUser: false },
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "exec-coord", isUser: false },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false },
                ],
            });
            await store.save();

            // Should return exec-coord (second-to-last), not user or architect
            const result = resolveCompletionRecipient(store);
            expect(result).toBe(EXEC_COORD_PUBKEY);
        });

        it("should resolve immediate delegator not the origin user", async () => {
            // This is the critical case: user responds to an ask, but completion
            // should route to the delegator, not the user
            const conversationId = "conv-ask-response";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY, // User answered an ask question
                content: "Yes, proceed",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                    { pubkey: ARCHITECT_PUBKEY, displayName: "architect", isUser: false },
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "exec-coord", isUser: false },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false },
                ],
            });
            await store.save();

            // Should return exec-coord (immediate delegator), not user
            const result = resolveCompletionRecipient(store);
            expect(result).toBe(EXEC_COORD_PUBKEY);
            expect(result).not.toBe(USER_PUBKEY);
        });
    });

    describe("createEventContext", () => {
        function createMockToolContext(
            conversationStore: ConversationStore | undefined,
            triggeringEventPubkey: string,
            conversationId: string
        ): ToolExecutionContext {
            const mockTriggeringEvent = {
                pubkey: triggeringEventPubkey,
                id: `event-${conversationId}`,
                tags: [],
            } as unknown as NDKEvent;

            return {
                triggeringEvent: mockTriggeringEvent,
                conversationId,
                ralNumber: 1,
                agent: {
                    llmConfig: "test-model",
                } as any,
                getConversation: conversationStore ? () => conversationStore : undefined,
            } as ToolExecutionContext;
        }

        it("should include completionRecipientPubkey when delegation chain exists", async () => {
            const conversationId = "conv-create-context";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: EXEC_COORD_PUBKEY,
                content: "Task",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                    { pubkey: EXEC_COORD_PUBKEY, displayName: "exec-coord", isUser: false },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false },
                ],
            });
            await store.save();

            const toolContext = createMockToolContext(store, USER_PUBKEY, conversationId);
            const eventContext = createEventContext(toolContext);

            expect(eventContext.completionRecipientPubkey).toBe(EXEC_COORD_PUBKEY);
            expect(eventContext.triggeringEvent.pubkey).toBe(USER_PUBKEY);
        });

        it("should set completionRecipientPubkey to undefined when no delegation chain", async () => {
            const conversationId = "conv-no-delegation";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Direct message",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            await store.save();

            const toolContext = createMockToolContext(store, USER_PUBKEY, conversationId);
            const eventContext = createEventContext(toolContext);

            expect(eventContext.completionRecipientPubkey).toBeUndefined();
        });

        it("should handle missing getConversation gracefully", () => {
            const conversationId = "conv-mcp-context";
            const mockTriggeringEvent = {
                pubkey: USER_PUBKEY,
                id: `event-${conversationId}`,
                tags: [],
            } as unknown as NDKEvent;

            const toolContext = {
                triggeringEvent: mockTriggeringEvent,
                conversationId,
                ralNumber: 1,
                agent: {
                    llmConfig: "test-model",
                } as any,
                // No getConversation - simulating MCP context
            } as ToolExecutionContext;

            const eventContext = createEventContext(toolContext);

            expect(eventContext.completionRecipientPubkey).toBeUndefined();
            expect(eventContext.conversationId).toBe(conversationId);
        });

        it("should support string options for model", async () => {
            const conversationId = "conv-model-string";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Hello",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            await store.save();

            const toolContext = createMockToolContext(store, USER_PUBKEY, conversationId);
            const eventContext = createEventContext(toolContext, "custom-model");

            expect(eventContext.model).toBe("custom-model");
        });

        it("should support object options with model and llmRuntime", async () => {
            const conversationId = "conv-options";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Hello",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });
            await store.save();

            const toolContext = createMockToolContext(store, USER_PUBKEY, conversationId);
            const eventContext = createEventContext(toolContext, {
                model: "gpt-4",
                llmRuntime: 1500,
            });

            expect(eventContext.model).toBe("gpt-4");
            expect(eventContext.llmRuntime).toBe(1500);
        });
    });
});
