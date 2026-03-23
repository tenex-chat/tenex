import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { ConversationStore } from "@/conversations/ConversationStore";
import {
    resolveCompletionRecipient,
    resolveCompletionRecipientPrincipal,
    createEventContext,
} from "../EventContextService";
import type { InboundEnvelope, PrincipalRef } from "@/events/runtime/InboundEnvelope";
import type { ToolExecutionContext } from "@/tools/types";

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

        it("should resolve immediate delegator when delegator triggers (ask-resume)", async () => {
            // Ask-resume case: originalTriggeringEventId is restored to the delegator's
            // message, so triggeringEventPubkey is the delegator, not the origin user
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

            // Triggering event is from exec-coord (delegator) due to originalTriggeringEventId restoration
            const result = resolveCompletionRecipient(store, EXEC_COORD_PUBKEY);
            expect(result).toBe(EXEC_COORD_PUBKEY);
            expect(result).not.toBe(USER_PUBKEY);
        });

        it("should return undefined when origin user directly triggers (direct interaction)", async () => {
            // Direct interaction case: after delegation completes, user messages
            // agent directly. The origin user IS the triggering event pubkey.
            // Completion should route back to the user (return undefined).
            const conversationId = "conv-direct-interaction";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Follow-up question",
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

            // Origin user directly triggers - should return undefined (route to user)
            const result = resolveCompletionRecipient(store, USER_PUBKEY);
            expect(result).toBeUndefined();
        });
    });

    describe("createEventContext", () => {
        function createMockEnvelope(params: {
            conversationId: string;
            transport?: InboundEnvelope["transport"];
            principal: PrincipalRef;
            nativeId?: string;
        }): InboundEnvelope {
            const transport = params.transport ?? params.principal.transport;
            const nativeId = params.nativeId ?? `event-${params.conversationId}`;

            return {
                transport,
                principal: params.principal,
                channel: {
                    id: `${transport}:conversation:${params.conversationId}`,
                    transport,
                    kind: "conversation",
                },
                message: {
                    id: `${transport}:${nativeId}`,
                    transport,
                    nativeId,
                },
                recipients: [],
                content: "trigger",
                occurredAt: Math.floor(Date.now() / 1000),
                capabilities: [],
                metadata: {},
            };
        }

        function createMockToolContext(
            conversationStore: ConversationStore | undefined,
            triggeringEventPubkey: string,
            conversationId: string
        ): ToolExecutionContext {
            return {
                triggeringEnvelope: createMockEnvelope({
                    conversationId,
                    principal: {
                        id: `nostr:${triggeringEventPubkey}`,
                        transport: "nostr",
                        linkedPubkey: triggeringEventPubkey,
                    },
                }),
                conversationId,
                ralNumber: 1,
                agent: {
                    llmConfig: "test-model",
                } as any,
                getConversation: conversationStore ? () => conversationStore : undefined,
            } as ToolExecutionContext;
        }

        it("should return undefined completionRecipientPubkey when origin user directly triggers", async () => {
            // Direct interaction: user (chain origin) messages agent after delegation completes.
            // The completion should route back to the user, not the intermediate delegator.
            const conversationId = "conv-create-context-direct";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Follow-up",
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

            expect(eventContext.completionRecipientPubkey).toBeUndefined();
            expect(eventContext.completionRecipientPrincipal).toEqual({
                id: `nostr:${USER_PUBKEY}`,
                transport: "nostr",
                linkedPubkey: USER_PUBKEY,
            });
            expect(eventContext.triggeringEnvelope.principal.linkedPubkey).toBe(USER_PUBKEY);
        });

        it("should include completionRecipientPubkey when delegator triggers (ask-resume)", async () => {
            // Ask-resume case: triggeringEnvelope is from exec-coord (restored via originalTriggeringEventId)
            const conversationId = "conv-create-context-ask";
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

            const toolContext = createMockToolContext(store, EXEC_COORD_PUBKEY, conversationId);
            const eventContext = createEventContext(toolContext);

            expect(eventContext.completionRecipientPubkey).toBe(EXEC_COORD_PUBKEY);
            expect(eventContext.completionRecipientPrincipal).toEqual({
                id: `nostr:${EXEC_COORD_PUBKEY}`,
                transport: "nostr",
                linkedPubkey: EXEC_COORD_PUBKEY,
                displayName: "exec-coord",
                kind: "agent",
            });
            expect(eventContext.triggeringEnvelope.principal.linkedPubkey).toBe(EXEC_COORD_PUBKEY);
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
            expect(eventContext.completionRecipientPrincipal).toEqual({
                id: `nostr:${USER_PUBKEY}`,
                transport: "nostr",
                linkedPubkey: USER_PUBKEY,
            });
        });

        it("should handle missing getConversation gracefully", () => {
            const conversationId = "conv-mcp-context";
            const toolContext = {
                triggeringEnvelope: createMockEnvelope({
                    conversationId,
                    principal: {
                        id: `nostr:${USER_PUBKEY}`,
                        transport: "nostr",
                        linkedPubkey: USER_PUBKEY,
                    },
                }),
                conversationId,
                ralNumber: 1,
                agent: {
                    llmConfig: "test-model",
                } as any,
                // No getConversation - simulating MCP context
            } as ToolExecutionContext;

            const eventContext = createEventContext(toolContext);

            expect(eventContext.completionRecipientPubkey).toBeUndefined();
            expect(eventContext.completionRecipientPrincipal).toEqual({
                id: `nostr:${USER_PUBKEY}`,
                transport: "nostr",
                linkedPubkey: USER_PUBKEY,
            });
            expect(eventContext.conversationId).toBe(conversationId);
        });

        it("should support object options for model", async () => {
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
            const eventContext = createEventContext(toolContext, { model: "custom-model" });

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

        it("should preserve a transport principal for direct local conversations", async () => {
            const conversationId = "conv-local-principal";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: USER_PUBKEY,
                senderPrincipal: {
                    id: "local:user:42",
                    transport: "local",
                    linkedPubkey: USER_PUBKEY,
                    displayName: "Alice Telegram",
                    kind: "human",
                },
                content: "hello from telegram",
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
                eventId: `event-${conversationId}`,
            });
            await store.save();

            const toolContext = {
                triggeringEnvelope: createMockEnvelope({
                    conversationId,
                    transport: "local",
                    principal: {
                        id: "local:user:42",
                        transport: "local",
                        linkedPubkey: USER_PUBKEY,
                        displayName: "Alice Telegram",
                        kind: "human",
                    },
                }),
                conversationId,
                ralNumber: 1,
                agent: {
                    llmConfig: "test-model",
                } as any,
                getConversation: () => store,
            } as ToolExecutionContext;
            const eventContext = createEventContext(toolContext);

            expect(eventContext.completionRecipientPubkey).toBeUndefined();
            expect(eventContext.completionRecipientPrincipal).toEqual({
                id: "local:user:42",
                transport: "local",
                linkedPubkey: USER_PUBKEY,
                displayName: "Alice Telegram",
                kind: "human",
            });
        });
    });

    describe("resolveCompletionRecipientPrincipal", () => {
        it("falls back to transport tags when conversation state is unavailable", () => {
            const triggeringEnvelope: InboundEnvelope = {
                transport: "local",
                principal: {
                    id: "local:user:99",
                    transport: "local",
                    linkedPubkey: USER_PUBKEY,
                },
                channel: {
                    id: "local:conversation:event-no-conversation",
                    transport: "local",
                    kind: "conversation",
                },
                message: {
                    id: "local:event-no-conversation",
                    transport: "local",
                    nativeId: "event-no-conversation",
                },
                recipients: [],
                content: "hello",
                occurredAt: Math.floor(Date.now() / 1000),
                capabilities: [],
                metadata: {},
            };

            expect(resolveCompletionRecipientPrincipal(undefined, triggeringEnvelope)).toEqual({
                id: "local:user:99",
                transport: "local",
                linkedPubkey: USER_PUBKEY,
            });
        });

        it("reuses the stored delegator principal when the delegation chain only has a linked pubkey", async () => {
            const conversationId = "conv-transport-aware-delegator";
            const store = ConversationStore.getOrLoad(conversationId);
            store.addMessage({
                pubkey: EXEC_COORD_PUBKEY,
                senderPrincipal: {
                    id: "telegram:user:77",
                    transport: "telegram",
                    linkedPubkey: EXEC_COORD_PUBKEY,
                    displayName: "Exec Coord Telegram",
                    kind: "agent",
                },
                content: "please handle this",
                messageType: "text",
                eventId: "delegator-telegram-msg",
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

            const triggeringEnvelope: InboundEnvelope = {
                transport: "nostr",
                principal: {
                    id: `nostr:${EXEC_COORD_PUBKEY}`,
                    transport: "nostr",
                    linkedPubkey: EXEC_COORD_PUBKEY,
                },
                channel: {
                    id: `nostr:conversation:${conversationId}`,
                    transport: "nostr",
                    kind: "conversation",
                },
                message: {
                    id: "nostr:delegator-telegram-msg",
                    transport: "nostr",
                    nativeId: "delegator-telegram-msg",
                },
                recipients: [],
                content: "resume",
                occurredAt: Math.floor(Date.now() / 1000),
                capabilities: [],
                metadata: {},
            };

            expect(resolveCompletionRecipientPrincipal(store, triggeringEnvelope)).toEqual({
                id: "telegram:user:77",
                transport: "telegram",
                linkedPubkey: EXEC_COORD_PUBKEY,
                displayName: "Exec Coord Telegram",
                kind: "agent",
            });
        });

        it("prefers the principal snapshot stored on the delegation chain", async () => {
            const conversationId = "conv-chain-principal";
            const store = ConversationStore.getOrLoad(conversationId);
            store.updateMetadata({
                delegationChain: [
                    { pubkey: USER_PUBKEY, displayName: "Pablo", isUser: true },
                    {
                        pubkey: EXEC_COORD_PUBKEY,
                        displayName: "exec-coord",
                        isUser: false,
                        principal: {
                            id: "telegram:user:88",
                            transport: "telegram",
                            linkedPubkey: EXEC_COORD_PUBKEY,
                            displayName: "Exec Coord Telegram",
                            username: "exec_coord",
                            kind: "agent",
                        },
                    },
                    { pubkey: CLAUDE_CODE_PUBKEY, displayName: "claude-code", isUser: false },
                ],
            });
            await store.save();

            const triggeringEnvelope: InboundEnvelope = {
                transport: "nostr",
                principal: {
                    id: `nostr:${EXEC_COORD_PUBKEY}`,
                    transport: "nostr",
                    linkedPubkey: EXEC_COORD_PUBKEY,
                },
                channel: {
                    id: `nostr:conversation:${conversationId}`,
                    transport: "nostr",
                    kind: "conversation",
                },
                message: {
                    id: "nostr:chain-principal-msg",
                    transport: "nostr",
                    nativeId: "chain-principal-msg",
                },
                recipients: [],
                content: "resume",
                occurredAt: Math.floor(Date.now() / 1000),
                capabilities: [],
                metadata: {},
            };

            expect(resolveCompletionRecipientPrincipal(store, triggeringEnvelope)).toEqual({
                id: "telegram:user:88",
                transport: "telegram",
                linkedPubkey: EXEC_COORD_PUBKEY,
                displayName: "Exec Coord Telegram",
                username: "exec_coord",
                kind: "agent",
            });
        });
    });
});
