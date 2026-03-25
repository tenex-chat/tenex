import { afterEach, describe, expect, it, mock } from "bun:test";
import type { RuntimeAgentRef } from "@/events/runtime/RuntimeAgent";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type { EventContext } from "@/nostr/types";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";

describe("TelegramDeliveryService", () => {
    const originalSendMessage = TelegramBotClient.prototype.sendMessage;
    const originalSendVoice = TelegramBotClient.prototype.sendVoice;
    type SendMessageResult = Awaited<ReturnType<TelegramBotClient["sendMessage"]>>;
    type SendVoiceResult = Awaited<ReturnType<TelegramBotClient["sendVoice"]>>;

    function createTelegramEnvelope(messageId: string): InboundEnvelope {
        return {
            transport: "telegram",
            principal: {
                id: "telegram:user:42",
                transport: "telegram",
                kind: "human",
            },
            channel: {
                id: "telegram:chat:1001",
                transport: "telegram",
                kind: "dm",
            },
            message: {
                id: `telegram:tg_1001_${messageId}`,
                transport: "telegram",
                nativeId: `tg_1001_${messageId}`,
            },
            recipients: [],
            content: "hello",
            occurredAt: 1_773_400_000,
            capabilities: ["telegram-bot"],
            metadata: {},
        };
    }

    afterEach(() => {
        TelegramBotClient.prototype.sendMessage = originalSendMessage;
        TelegramBotClient.prototype.sendVoice = originalSendVoice;
        mock.restore();
    });

    it("renders replies with Telegram HTML parse mode", async () => {
        const calls: Array<Record<string, unknown>> = [];
        TelegramBotClient.prototype.sendMessage = async function sendMessage(params) {
            calls.push(params as unknown as Record<string, unknown>);
            return {} as SendMessageResult;
        };

        const service = new TelegramDeliveryService();
        await service.sendReply(
            {
                slug: "telegram-agent",
                telegram: {
                    botToken: "token",
                },
            } as RuntimeAgentRef,
            {
                conversationId: "conversation-1",
                triggeringEnvelope: createTelegramEnvelope("5"),
            } as EventContext,
            "Hello **world**"
        );

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            chatId: "1001",
            parseMode: "HTML",
            replyToMessageId: "5",
            text: "Hello <b>world</b>",
        });
    });

    it("falls back to plain text when Telegram rejects rendered HTML", async () => {
        const calls: Array<Record<string, unknown>> = [];
        TelegramBotClient.prototype.sendMessage = async function sendMessage(params) {
            calls.push(params as unknown as Record<string, unknown>);
            if (calls.length === 1) {
                throw new Error("can't parse entities");
            }
            return {} as SendMessageResult;
        };

        const service = new TelegramDeliveryService();
        await service.sendReply(
            {
                slug: "telegram-agent",
                telegram: {
                    botToken: "token",
                },
            } as RuntimeAgentRef,
            {
                conversationId: "conversation-2",
                triggeringEnvelope: createTelegramEnvelope("6"),
            } as EventContext,
            "Hello **world**"
        );

        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({
            parseMode: "HTML",
            text: "Hello <b>world</b>",
        });
        expect(calls[1]).toMatchObject({
            chatId: "1001",
            replyToMessageId: "6",
            text: "Hello **world**",
        });
        expect(calls[1]?.parseMode).toBeUndefined();
    });

    it("sends reserved telegram_voice markers as voice replies and strips them from text follow-ups", async () => {
        const voiceCalls: Array<Record<string, unknown>> = [];
        const messageCalls: Array<Record<string, unknown>> = [];
        TelegramBotClient.prototype.sendVoice = async function sendVoice(params) {
            voiceCalls.push(params as unknown as Record<string, unknown>);
            return {} as SendVoiceResult;
        };
        TelegramBotClient.prototype.sendMessage = async function sendMessage(params) {
            messageCalls.push(params as unknown as Record<string, unknown>);
            return {} as SendMessageResult;
        };

        const service = new TelegramDeliveryService();
        await service.sendReply(
            {
                slug: "telegram-agent",
                telegram: {
                    botToken: "token",
                },
            } as RuntimeAgentRef,
            {
                conversationId: "conversation-3",
                triggeringEnvelope: createTelegramEnvelope("8"),
            } as EventContext,
            "Here is the voice summary.\n\n[[telegram_voice:/tmp/reply.ogg]]"
        );

        expect(voiceCalls).toHaveLength(1);
        expect(voiceCalls[0]).toMatchObject({
            chatId: "1001",
            replyToMessageId: "8",
            voicePath: "/tmp/reply.ogg",
        });
        expect(messageCalls).toHaveLength(1);
        expect(messageCalls[0]).toMatchObject({
            chatId: "1001",
            parseMode: "HTML",
            replyToMessageId: "8",
            text: "Here is the voice summary.",
        });
        expect(String(messageCalls[0]?.text)).not.toContain("telegram_voice");
    });

    it("sends proactive channel messages with Telegram HTML parse mode", async () => {
        const calls: Array<Record<string, unknown>> = [];
        TelegramBotClient.prototype.sendMessage = async function sendMessage(params) {
            calls.push(params as unknown as Record<string, unknown>);
            return {} as SendMessageResult;
        };

        const service = new TelegramDeliveryService();
        await service.sendToChannel({
            botToken: "token",
            chatId: "1001",
            messageThreadId: "77",
            content: "Hello **channel**",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            chatId: "1001",
            messageThreadId: "77",
            parseMode: "HTML",
            text: "Hello <b>channel</b>",
        });
    });

    it("falls back to plain text for proactive channel messages when Telegram rejects rendered HTML", async () => {
        const calls: Array<Record<string, unknown>> = [];
        TelegramBotClient.prototype.sendMessage = async function sendMessage(params) {
            calls.push(params as unknown as Record<string, unknown>);
            if (calls.length === 1) {
                throw new Error("can't parse entities");
            }
            return {} as SendMessageResult;
        };

        const service = new TelegramDeliveryService();
        await service.sendToChannel({
            botToken: "token",
            chatId: "1001",
            content: "Hello **channel**",
        });

        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({
            chatId: "1001",
            parseMode: "HTML",
            text: "Hello <b>channel</b>",
        });
        expect(calls[1]).toMatchObject({
            chatId: "1001",
            text: "Hello **channel**",
        });
        expect(calls[1]?.parseMode).toBeUndefined();
    });
});
