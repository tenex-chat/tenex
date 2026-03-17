import { afterEach, describe, expect, it } from "bun:test";
import type { EventContext } from "@/nostr/types";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";

describe("TelegramDeliveryService", () => {
    const originalSendMessage = TelegramBotClient.prototype.sendMessage;

    afterEach(() => {
        TelegramBotClient.prototype.sendMessage = originalSendMessage;
    });

    it("renders replies with Telegram HTML parse mode", async () => {
        const calls: Array<Record<string, unknown>> = [];
        TelegramBotClient.prototype.sendMessage = async function sendMessage(params) {
            calls.push(params as unknown as Record<string, unknown>);
            return {} as any;
        };

        const service = new TelegramDeliveryService();
        await service.sendReply(
            {
                slug: "telegram-agent",
                telegram: {
                    botToken: "token",
                },
            } as any,
            {
                conversationId: "conversation-1",
                triggeringEvent: {
                    pubkey: "f".repeat(64),
                    tags: [
                        ["transport", "telegram"],
                        ["telegram-chat-id", "1001"],
                        ["telegram-message-id", "5"],
                    ],
                } as any,
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
            return {} as any;
        };

        const service = new TelegramDeliveryService();
        await service.sendReply(
            {
                slug: "telegram-agent",
                telegram: {
                    botToken: "token",
                },
            } as any,
            {
                conversationId: "conversation-2",
                triggeringEvent: {
                    pubkey: "f".repeat(64),
                    tags: [
                        ["transport", "telegram"],
                        ["telegram-chat-id", "1001"],
                        ["telegram-message-id", "6"],
                    ],
                } as any,
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
});
