import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";

const TELEGRAM_BOT_COMMANDS = [
    { command: "model", description: "Change the agent model" },
    { command: "config", description: "Change the agent tools" },
    { command: "new", description: "Start a fresh conversation" },
];

describe("TelegramBotClient", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        mock.restore();
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

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

    it("requests callback query updates when allowedUpdates are provided", async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL) =>
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
            offset: 25,
            timeoutSeconds: 20,
            limit: 50,
            allowedUpdates: ["message", "edited_message", "callback_query"],
        });

        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/getUpdates?offset=25&timeout=20&limit=50&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22callback_query%22%5D"
        );
    });

    it("requests group metadata endpoints with the expected query parameters", async () => {
        const fetchImpl = mock(async (input: RequestInfo | URL) => {
            const url = String(input);

            if (url.includes("/getChat?")) {
                return new Response(
                    JSON.stringify({
                        ok: true,
                        result: {
                            id: -2001,
                            type: "supergroup",
                            title: "Operators",
                            username: "operators_hq",
                        },
                    }),
                    { status: 200 }
                );
            }

            if (url.includes("/getChatAdministrators?")) {
                return new Response(
                    JSON.stringify({
                        ok: true,
                        result: [{
                            status: "administrator",
                            user: {
                                id: 7,
                                is_bot: false,
                                first_name: "Ada",
                                username: "ada_admin",
                            },
                        }],
                    }),
                    { status: 200 }
                );
            }

            return new Response(
                JSON.stringify({
                    ok: true,
                    result: 14,
                }),
                { status: 200 }
            );
        });
        const client = new TelegramBotClient({
            botToken: "test-token",
            apiBaseUrl: "https://telegram.example",
            fetchImpl,
        });

        await client.getChat({ chatId: "-2001" });
        await client.getChatAdministrators({ chatId: "-2001" });
        await client.getChatMemberCount({ chatId: "-2001" });

        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/getChat?chat_id=-2001"
        );
        expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
            "https://telegram.example/bottest-token/getChatAdministrators?chat_id=-2001"
        );
        expect(String(fetchImpl.mock.calls[2]?.[0])).toBe(
            "https://telegram.example/bottest-token/getChatMemberCount?chat_id=-2001"
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
            chatId: "-1001",
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
            chat_id: "-1001",
            text: "hello",
            parse_mode: "HTML",
            allow_sending_without_reply: true,
            reply_to_message_id: 7,
            message_thread_id: 15,
        });
    });

    it("rejects invalid sendMessage thread targets before calling Telegram", async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
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

        await expect(client.sendMessage({
            chatId: "5104033799",
            text: "hello",
            messageThreadId: "test",
        })).rejects.toThrow("Invalid Telegram message thread ID: test. Thread IDs must be numeric.");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("posts reply_markup with sendMessage payloads", async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(
                JSON.stringify({
                    ok: true,
                    result: {
                        message_id: 8,
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
            text: "pick one",
            replyMarkup: {
                inline_keyboard: [[
                    {
                        text: "Model A",
                        callback_data: "tgcfg:abc:sm:0",
                    },
                ]],
            },
        });

        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
            chat_id: "1001",
            text: "pick one",
            allow_sending_without_reply: true,
            reply_markup: {
                inline_keyboard: [[
                    {
                        text: "Model A",
                        callback_data: "tgcfg:abc:sm:0",
                    },
                ]],
            },
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
            chatId: "-1001",
            action: "typing",
            messageThreadId: "15",
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/sendChatAction"
        );
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
            chat_id: "-1001",
            action: "typing",
            message_thread_id: 15,
        });
    });

    it("posts sendVoice payloads as multipart form data", async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(
                JSON.stringify({
                    ok: true,
                    result: {
                        message_id: 9,
                        date: 123,
                        chat: { id: 1001, type: "private" },
                    },
                }),
                { status: 200 }
            )
        );
        const tempDir = mkdtempSync(join(tmpdir(), "telegram-voice-"));
        const voicePath = join(tempDir, "reply.ogg");
        tempDirs.push(tempDir);
        writeFileSync(voicePath, "voice-data");

        const client = new TelegramBotClient({
            botToken: "test-token",
            apiBaseUrl: "https://telegram.example",
            fetchImpl,
        });

        await client.sendVoice({
            chatId: "-1001",
            voicePath,
            replyToMessageId: "7",
            messageThreadId: "15",
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/sendVoice"
        );
        expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
            method: "POST",
        });

        const body = fetchImpl.mock.calls[0]?.[1]?.body;
        expect(body).toBeInstanceOf(FormData);

        const formData = body as FormData;
        expect(formData.get("chat_id")).toBe("-1001");
        expect(formData.get("reply_to_message_id")).toBe("7");
        expect(formData.get("message_thread_id")).toBe("15");
        expect(formData.get("allow_sending_without_reply")).toBe("true");

        const voice = formData.get("voice");
        expect(voice).toBeInstanceOf(File);
        expect((voice as File).name).toBe("reply.ogg");
        expect((voice as File).type).toBe("audio/ogg");
    });

    it("posts editMessageText payloads in Telegram Bot API format", async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(
                JSON.stringify({
                    ok: true,
                    result: {
                        message_id: 9,
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

        await client.editMessageText({
            chatId: "1001",
            messageId: "9",
            text: "updated",
            replyMarkup: {
                inline_keyboard: [[
                    {
                        text: "Cancel",
                        callback_data: "tgcfg:abc:cancel",
                    },
                ]],
            },
        });

        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/editMessageText"
        );
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
            chat_id: "1001",
            message_id: 9,
            text: "updated",
            reply_markup: {
                inline_keyboard: [[
                    {
                        text: "Cancel",
                        callback_data: "tgcfg:abc:cancel",
                    },
                ]],
            },
        });
    });

    it("posts answerCallbackQuery payloads in Telegram Bot API format", async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
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

        await client.answerCallbackQuery({
            callbackQueryId: "callback-1",
            text: "Saved",
            showAlert: true,
        });

        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/answerCallbackQuery"
        );
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
            callback_query_id: "callback-1",
            text: "Saved",
            show_alert: true,
        });
    });

    it("posts setMyCommands payloads in Telegram Bot API format", async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
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

        await client.setMyCommands({
            commands: TELEGRAM_BOT_COMMANDS,
        });

        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            "https://telegram.example/bottest-token/setMyCommands"
        );
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
            commands: TELEGRAM_BOT_COMMANDS,
        });
    });
});
