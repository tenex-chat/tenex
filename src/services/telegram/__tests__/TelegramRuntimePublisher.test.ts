import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { EventContext } from "@/nostr/types";
import { TelegramRuntimePublisher } from "@/services/telegram/TelegramRuntimePublisherService";

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

mock.module("@/nostr/AgentPublisher", () => ({
    AgentPublisher: class {
        complete = nostrPublisherMethods.complete;
        conversation = nostrPublisherMethods.conversation;
        delegate = nostrPublisherMethods.delegate;
        ask = nostrPublisherMethods.ask;
        delegateFollowup = nostrPublisherMethods.delegateFollowup;
        error = nostrPublisherMethods.error;
        lesson = nostrPublisherMethods.lesson;
        toolUse = nostrPublisherMethods.toolUse;
        streamTextDelta = nostrPublisherMethods.streamTextDelta;
        delegationMarker = nostrPublisherMethods.delegationMarker;
    },
}));

describe("TelegramRuntimePublisher", () => {
    beforeEach(() => {
        Object.values(nostrPublisherMethods).forEach((method) => method.mockReset());
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
    });

    it("delivers completions to Telegram when the triggering context is Telegram", async () => {
        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisher(
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
            triggeringEvent: {
                pubkey: "f".repeat(64),
                tags: [["transport", "telegram"]],
            } as any,
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

    it("returns the generated event when Telegram recovery succeeds after a Nostr publish failure", async () => {
        const recoveredEvent = {
            id: "event-1",
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
        const publisher = new TelegramRuntimePublisher(
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
            triggeringEvent: {
                pubkey: "f".repeat(64),
                tags: [["transport", "telegram"]],
            } as any,
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
