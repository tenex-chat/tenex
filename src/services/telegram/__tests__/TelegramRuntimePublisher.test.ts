import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import type { EventContext } from "@/nostr/types";
import { TelegramRuntimePublisherService } from "@/services/telegram/TelegramRuntimePublisherService";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";

const nostrPublisherMethods = {
    complete: mock(async () => undefined),
    conversation: mock(async () => ({}) as any),
    delegate: mock(async () => "delegation-id"),
    ask: mock(async () => ({}) as any),
    delegateFollowup: mock(async () => "followup-id"),
    error: mock(async () => ({}) as any),
    lesson: mock(async () => ({}) as any),
    toolUse: mock(async () => ({}) as any),
    streamTextDelta: mock(async () => undefined),
    delegationMarker: mock(async () => ({}) as any),
};

const createTelegramEnvelope = (messageId: string) =>
    createMockInboundEnvelope({
        transport: "telegram",
        principal: {
            id: "telegram:user:42",
            transport: "telegram",
            linkedPubkey: "f".repeat(64),
            kind: "human",
        },
        channel: {
            id: "telegram:chat:42",
            transport: "telegram",
            kind: "dm",
        },
        message: {
            id: messageId,
            transport: "telegram",
            nativeId: `telegram:chat:42:message:${messageId}`,
        },
    });

describe("TelegramRuntimePublisherService", () => {
    beforeEach(() => {
        for (const method of Object.values(nostrPublisherMethods)) method.mockReset();
        nostrPublisherMethods.complete.mockImplementation(async () => undefined);
        nostrPublisherMethods.conversation.mockImplementation(async () => ({}) as any);
        nostrPublisherMethods.delegate.mockImplementation(async () => "delegation-id");
        nostrPublisherMethods.ask.mockImplementation(async () => ({}) as any);
        nostrPublisherMethods.delegateFollowup.mockImplementation(async () => "followup-id");
        nostrPublisherMethods.error.mockImplementation(async () => ({}) as any);
        nostrPublisherMethods.lesson.mockImplementation(async () => ({}) as any);
        nostrPublisherMethods.toolUse.mockImplementation(async () => ({}) as any);
        nostrPublisherMethods.streamTextDelta.mockImplementation(async () => undefined);
        nostrPublisherMethods.delegationMarker.mockImplementation(async () => ({}) as any);

        spyOn(AgentPublisher.prototype, "complete").mockImplementation(nostrPublisherMethods.complete);
        spyOn(AgentPublisher.prototype, "conversation").mockImplementation(
            nostrPublisherMethods.conversation
        );
        spyOn(AgentPublisher.prototype, "delegate").mockImplementation(nostrPublisherMethods.delegate);
        spyOn(AgentPublisher.prototype, "ask").mockImplementation(nostrPublisherMethods.ask);
        spyOn(AgentPublisher.prototype, "delegateFollowup").mockImplementation(
            nostrPublisherMethods.delegateFollowup
        );
        spyOn(AgentPublisher.prototype, "error").mockImplementation(nostrPublisherMethods.error);
        spyOn(AgentPublisher.prototype, "lesson").mockImplementation(nostrPublisherMethods.lesson);
        spyOn(AgentPublisher.prototype, "toolUse").mockImplementation(nostrPublisherMethods.toolUse);
        spyOn(AgentPublisher.prototype, "streamTextDelta").mockImplementation(
            nostrPublisherMethods.streamTextDelta
        );
        spyOn(AgentPublisher.prototype, "delegationMarker").mockImplementation(
            nostrPublisherMethods.delegationMarker
        );
    });

    afterEach(() => {
        mock.restore();
    });

    it("delivers completions to Telegram when the triggering context is Telegram", async () => {
        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisherService(
            {
                slug: "telegram-agent",
                pubkey: "a".repeat(64),
                telegram: {
                    botToken: "token",
                },
            } as any,
            {
                canHandle: () => true,
                sendReply,
            } as any
        );

        const context: EventContext = {
            conversationId: "conversation-1",
            ralNumber: 1,
            rootEvent: { id: "root-1" },
            triggeringEnvelope: createTelegramEnvelope("101"),
        };

        await publisher.complete({ content: "hello telegram" }, context);

        expect(nostrPublisherMethods.complete).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledWith(
            expect.anything(),
            context,
            "hello telegram"
        );
    });

    it("does not deliver conversation updates to Telegram by default", async () => {
        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisherService(
            {
                slug: "telegram-agent",
                pubkey: "a".repeat(64),
                telegram: {
                    botToken: "token",
                },
            } as any,
            {
                canHandle: () => true,
                sendReply,
            } as any
        );

        const context: EventContext = {
            conversationId: "conversation-1b",
            ralNumber: 1,
            rootEvent: { id: "root-1b" },
            triggeringEnvelope: createTelegramEnvelope("1011"),
        };

        await publisher.conversation({ content: "working on it" }, context);

        // Nostr publishing still happens, but Telegram delivery is disabled by default
        expect(nostrPublisherMethods.conversation).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledTimes(0);
    });

    it("delivers conversation updates to Telegram when publishConversationToTelegram is enabled", async () => {
        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisherService(
            {
                slug: "telegram-agent",
                pubkey: "a".repeat(64),
                telegram: {
                    botToken: "token",
                    publishConversationToTelegram: true,
                },
            } as any,
            {
                canHandle: () => true,
                sendReply,
            } as any
        );

        const context: EventContext = {
            conversationId: "conversation-1b",
            ralNumber: 1,
            rootEvent: { id: "root-1b" },
            triggeringEnvelope: createTelegramEnvelope("1011"),
        };

        await publisher.conversation({ content: "working on it" }, context);

        expect(nostrPublisherMethods.conversation).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledWith(expect.anything(), context, "working on it");
    });

    it("does not deliver reasoning blocks to Telegram by default", async () => {
        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisherService(
            {
                slug: "telegram-agent",
                pubkey: "a".repeat(64),
                telegram: {
                    botToken: "token",
                },
            } as any,
            {
                canHandle: () => true,
                sendReply,
            } as any
        );

        const context: EventContext = {
            conversationId: "conversation-reasoning",
            ralNumber: 1,
            rootEvent: { id: "root-reasoning" },
            triggeringEnvelope: createTelegramEnvelope("1012"),
        };

        await publisher.conversation({ content: "thinking...", isReasoning: true }, context);

        // Nostr publishing still happens, but Telegram delivery is disabled by default for reasoning
        expect(nostrPublisherMethods.conversation).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledTimes(0);
    });

    it("delivers reasoning blocks to Telegram when publishReasoningToTelegram is enabled", async () => {
        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisherService(
            {
                slug: "telegram-agent",
                pubkey: "a".repeat(64),
                telegram: {
                    botToken: "token",
                    publishReasoningToTelegram: true,
                },
            } as any,
            {
                canHandle: () => true,
                sendReply,
            } as any
        );

        const context: EventContext = {
            conversationId: "conversation-reasoning",
            ralNumber: 1,
            rootEvent: { id: "root-reasoning" },
            triggeringEnvelope: createTelegramEnvelope("1012"),
        };

        await publisher.conversation({ content: "thinking...", isReasoning: true }, context);

        expect(nostrPublisherMethods.conversation).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledWith(expect.anything(), context, "thinking...");
    });

    it("delivers allowlisted todo_write tool updates to Telegram", async () => {
        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisherService(
            {
                slug: "telegram-agent",
                pubkey: "a".repeat(64),
                telegram: {
                    botToken: "token",
                },
            } as any,
            {
                canHandle: () => true,
                sendReply,
            } as any
        );

        const context: EventContext = {
            conversationId: "conversation-tools",
            ralNumber: 1,
            rootEvent: { id: "root-tools" },
            triggeringEnvelope: createTelegramEnvelope("103"),
        };

        await publisher.toolUse(
            {
                toolName: "todo_write",
                content: "Executing todo_write",
                args: {
                    todos: [
                        {
                            title: "Read file one",
                            status: "in_progress",
                        },
                        {
                            title: "Read file two",
                            status: "pending",
                        },
                    ],
                },
            },
            context
        );

        expect(nostrPublisherMethods.toolUse).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledWith(
            expect.anything(),
            context,
            [
                "**Updating todo list**",
                "",
                "2 items: 1 in progress, 1 pending",
                "",
                "- In progress: Read file one",
                "- Pending: Read file two",
            ].join("\n")
        );
    });

    it("does not deliver non-allowlisted tool updates to Telegram", async () => {
        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisherService(
            {
                slug: "telegram-agent",
                pubkey: "a".repeat(64),
                telegram: {
                    botToken: "token",
                },
            } as any,
            {
                canHandle: () => true,
                sendReply,
            } as any
        );

        const context: EventContext = {
            conversationId: "conversation-tools-2",
            ralNumber: 1,
            rootEvent: { id: "root-tools-2" },
            triggeringEnvelope: createTelegramEnvelope("104"),
        };

        await publisher.toolUse(
            {
                toolName: "shell_execute",
                content: "Executing shell_execute",
                args: { command: "pwd" },
            },
            context
        );

        expect(nostrPublisherMethods.toolUse).toHaveBeenCalledTimes(1);
        expect(sendReply).not.toHaveBeenCalled();
    });

    it("returns the generated event when Telegram recovery succeeds after a Nostr publish failure", async () => {
        const recoveredEvent = {
            id: "event-1",
            transport: "nostr",
            content: "hello telegram",
            tags: [],
        } as any;
        nostrPublisherMethods.complete.mockImplementation(async () => {
            throw {
                message: "Failed to publish completion: 0 relays",
                event: recoveredEvent,
                eventType: "completion",
            };
        });

        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisherService(
            {
                slug: "telegram-agent",
                pubkey: "a".repeat(64),
                telegram: {
                    botToken: "token",
                },
            } as any,
            {
                canHandle: () => true,
                sendReply,
            } as any
        );

        const context: EventContext = {
            conversationId: "conversation-2",
            ralNumber: 1,
            rootEvent: { id: "root-2" },
            triggeringEnvelope: createTelegramEnvelope("102"),
        };

        const event = await publisher.complete({ content: "hello telegram" }, context);

        expect(event).toBe(recoveredEvent);
        expect(sendReply).toHaveBeenCalledTimes(1);
        expect(sendReply).toHaveBeenCalledWith(
            expect.anything(),
            context,
            "hello telegram"
        );
    });
});
