import { describe, expect, it, mock } from "bun:test";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";

describe("TelegramBotClient", () => {
    it("requests updates with the expected query parameters", async () => {
        const fetchImpl = mock(async (input: RequestInfo | URL) =>
            new Response(
                JSON.stringify({
                    ok: true,
                    result: [],
                }),
                { status: 200 }
            )
        );
        const client = new TelegramBotClient({
            botToken: "test-token",
            apiBaseUrl: "https://telegram.example",
            fetchImpl,
        });

        await client.getUpdates({
            offset: 10,
            timeoutSeconds: 5,
            limit: 25,
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/getUpdates?offset=10&timeout=5&limit=25"
        );
    });

    it("posts sendMessage payloads in Telegram Bot API format", async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) =>
            new Response(
                JSON.stringify({
                    ok: true,
                    result: {
                        message_id: 5,
                        date: 123,
                        chat: { id: 1001, type: "private" },
                    },
                }),
                { status: 200 }
            )
        );
        const client = new TelegramBotClient({
            botToken: "test-token",
            apiBaseUrl: "https://telegram.example",
            fetchImpl,
        });

        await client.sendMessage({
            chatId: "1001",
            text: "hello",
            parseMode: "HTML",
            replyToMessageId: "7",
            messageThreadId: "15",
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/sendMessage"
        );
        expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
        });
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
            chat_id: "1001",
            text: "hello",
            parse_mode: "HTML",
            allow_sending_without_reply: true,
            reply_to_message_id: 7,
            message_thread_id: 15,
        });
    });

    it("posts sendChatAction payloads in Telegram Bot API format", async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) =>
            new Response(
                JSON.stringify({
                    ok: true,
                    result: true,
                }),
                { status: 200 }
            )
        );
        const client = new TelegramBotClient({
            botToken: "test-token",
            apiBaseUrl: "https://telegram.example",
            fetchImpl,
        });

        await client.sendChatAction({
            chatId: "1001",
            action: "typing",
            messageThreadId: "15",
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/sendChatAction"
        );
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
            chat_id: "1001",
            action: "typing",
            message_thread_id: 15,
        });
    });
});
