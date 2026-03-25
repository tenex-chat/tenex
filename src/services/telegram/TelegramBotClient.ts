import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import type {
    TelegramAnswerCallbackQueryParams,
    TelegramBotCommand,
    TelegramEditMessageTextParams,
    TelegramGetChatAdministratorsResponse,
    TelegramGetChatMemberCountResponse,
    TelegramGetChatResponse,
    TelegramGetFileResponse,
    TelegramGetMeResponse,
    TelegramGetUpdatesResponse,
    TelegramMessage,
    TelegramSendChatActionParams,
    TelegramSendMessageParams,
    TelegramSendMessageResponse,
    TelegramSendVoiceParams,
} from "@/services/telegram/types";
import { withActiveTraceLogFields } from "@/telemetry/TelegramTelemetry";
import { logger } from "@/utils/logger";
import { SpanStatusCode, trace } from "@opentelemetry/api";

interface TelegramBotClientOptions {
    botToken: string;
    apiBaseUrl?: string;
    fetchImpl?: typeof fetch;
}

interface ApiCallResult<T> {
    parsedBody: unknown;
    result: T;
}

const tracer = trace.getTracer("tenex.telegram.bot-client");

function normalizeApiBaseUrl(apiBaseUrl: string | undefined): string {
    return (apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
}

function safeSerialize(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

async function parseTelegramResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        throw new Error(`Telegram Bot API request failed with status ${response.status}`);
    }

    const parsed = await response.json() as { ok?: boolean; description?: string };
    if (!parsed.ok) {
        throw new Error(parsed.description || "Telegram Bot API returned ok=false");
    }

    return parsed as T;
}

function detectVoiceMimeType(voicePath: string): string {
    switch (extname(voicePath).toLowerCase()) {
        case ".ogg":
        case ".oga":
        case ".opus":
            return "audio/ogg";
        case ".mp3":
            return "audio/mpeg";
        case ".m4a":
            return "audio/mp4";
        default:
            return "application/octet-stream";
    }
}

export class TelegramBotClient {
    private readonly apiBaseUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly options: TelegramBotClientOptions) {
        this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    private getTokenSuffix(): string {
        return this.options.botToken.slice(-6);
    }

    private async runApiCall<T>(params: {
        operation:
            | "answerCallbackQuery"
            | "editMessageText"
            | "getChat"
            | "getChatAdministrators"
            | "getChatMemberCount"
            | "getFile"
            | "getMe"
            | "getUpdates"
            | "setMyCommands"
            | "sendMessage"
            | "sendVoice"
            | "sendChatAction";
        method: "GET" | "POST";
        requestBody?: unknown;
        requestQuery?: Record<string, unknown>;
        attributes?: Record<string, boolean | number | string>;
        responseAttributes?: (result: T) => Record<string, boolean | number | string>;
        execute: () => Promise<ApiCallResult<T>>;
    }): Promise<T> {
        return tracer.startActiveSpan(
            `tenex.telegram.api.${params.operation}`,
            {
                attributes: {
                    "telegram.api.operation": params.operation,
                    "telegram.api.method": params.method,
                    "telegram.api.base_url": this.apiBaseUrl,
                    "telegram.bot.token_suffix": this.getTokenSuffix(),
                    ...params.attributes,
                },
            },
            async (span) => {
                const startedAt = Date.now();
                const requestEventAttributes: Record<string, string> = {
                    "telegram.api.request.body": safeSerialize(params.requestBody ?? {}),
                    "telegram.api.request.query": safeSerialize(params.requestQuery ?? {}),
                };

                span.addEvent("telegram.api.request", requestEventAttributes);
                logger.info("[TelegramBotClient] Telegram API request", withActiveTraceLogFields({
                    operation: params.operation,
                    method: params.method,
                    apiBaseUrl: this.apiBaseUrl,
                    botTokenSuffix: this.getTokenSuffix(),
                    requestQuery: params.requestQuery,
                    requestBody: params.requestBody,
                }));

                try {
                    const { parsedBody, result } = await params.execute();
                    const durationMs = Date.now() - startedAt;
                    const responseAttributes = params.responseAttributes?.(result) ?? {};

                    span.setAttributes({
                        "telegram.api.duration_ms": durationMs,
                        ...responseAttributes,
                    });
                    span.addEvent("telegram.api.response", {
                        "telegram.api.response.body": safeSerialize(parsedBody),
                    });
                    span.setStatus({ code: SpanStatusCode.OK });

                    logger.info("[TelegramBotClient] Telegram API response", withActiveTraceLogFields({
                        operation: params.operation,
                        method: params.method,
                        apiBaseUrl: this.apiBaseUrl,
                        botTokenSuffix: this.getTokenSuffix(),
                        durationMs,
                        responseBody: parsedBody,
                        ...responseAttributes,
                    }));

                    return result;
                } catch (error) {
                    const durationMs = Date.now() - startedAt;
                    span.recordException(error as Error);
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: error instanceof Error ? error.message : String(error),
                    });

                    logger.warn("[TelegramBotClient] Telegram API failure", withActiveTraceLogFields({
                        operation: params.operation,
                        method: params.method,
                        apiBaseUrl: this.apiBaseUrl,
                        botTokenSuffix: this.getTokenSuffix(),
                        durationMs,
                        requestQuery: params.requestQuery,
                        requestBody: params.requestBody,
                        error: error instanceof Error ? error.message : String(error),
                    }));

                    throw error;
                } finally {
                    span.end();
                }
            }
        );
    }

    async getMe(): Promise<TelegramGetMeResponse["result"]> {
        return this.runApiCall({
            operation: "getMe",
            method: "GET",
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/getMe`
                );
                const parsed = await parseTelegramResponse<TelegramGetMeResponse>(response);
                return {
                    parsedBody: parsed,
                    result: parsed.result,
                };
            },
            responseAttributes: (result) => ({
                "telegram.bot.id": String(result.id),
                "telegram.bot.username": result.username ?? "",
            }),
        });
    }

    async getChat(params: {
        chatId: string;
    }): Promise<TelegramGetChatResponse["result"]> {
        const search = new URLSearchParams({
            chat_id: params.chatId,
        });

        return this.runApiCall({
            operation: "getChat",
            method: "GET",
            requestQuery: {
                chat_id: params.chatId,
            },
            attributes: {
                "telegram.chat.id": params.chatId,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/getChat?${search.toString()}`
                );
                const parsed = await parseTelegramResponse<TelegramGetChatResponse>(response);
                return {
                    parsedBody: parsed,
                    result: parsed.result,
                };
            },
            responseAttributes: (result) => ({
                "telegram.chat.id": String(result.id),
                "telegram.chat.type": result.type,
                "telegram.chat.title": result.title ?? "",
                "telegram.chat.username": result.username ?? "",
            }),
        });
    }

    async getChatAdministrators(params: {
        chatId: string;
    }): Promise<TelegramGetChatAdministratorsResponse["result"]> {
        const search = new URLSearchParams({
            chat_id: params.chatId,
        });

        return this.runApiCall({
            operation: "getChatAdministrators",
            method: "GET",
            requestQuery: {
                chat_id: params.chatId,
            },
            attributes: {
                "telegram.chat.id": params.chatId,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/getChatAdministrators?${search.toString()}`
                );
                const parsed = await parseTelegramResponse<TelegramGetChatAdministratorsResponse>(
                    response
                );
                return {
                    parsedBody: parsed,
                    result: parsed.result,
                };
            },
            responseAttributes: (result) => ({
                "telegram.chat.admin_count": result.length,
            }),
        });
    }

    async getChatMemberCount(params: {
        chatId: string;
    }): Promise<number> {
        const search = new URLSearchParams({
            chat_id: params.chatId,
        });

        return this.runApiCall({
            operation: "getChatMemberCount",
            method: "GET",
            requestQuery: {
                chat_id: params.chatId,
            },
            attributes: {
                "telegram.chat.id": params.chatId,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/getChatMemberCount?${search.toString()}`
                );
                const parsed = await parseTelegramResponse<TelegramGetChatMemberCountResponse>(
                    response
                );
                return {
                    parsedBody: parsed,
                    result: parsed.result,
                };
            },
            responseAttributes: (result) => ({
                "telegram.chat.member_count": result,
            }),
        });
    }

    async setMyCommands(params: {
        commands: TelegramBotCommand[];
    }): Promise<void> {
        const payload = {
            commands: params.commands,
        };

        await this.runApiCall({
            operation: "setMyCommands",
            method: "POST",
            requestBody: payload,
            attributes: {
                "telegram.bot.command_count": params.commands.length,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/setMyCommands`,
                    {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                        },
                        body: JSON.stringify(payload),
                    }
                );
                const parsed = await parseTelegramResponse<{ ok: boolean; result: true }>(response);
                return {
                    parsedBody: parsed,
                    result: undefined,
                };
            },
        });
    }

    async getUpdates(params: {
        offset?: number;
        timeoutSeconds?: number;
        limit?: number;
        allowedUpdates?: string[];
        signal?: AbortSignal;
    }): Promise<TelegramGetUpdatesResponse["result"]> {
        const search = new URLSearchParams();
        if (params.offset !== undefined) {
            search.set("offset", String(params.offset));
        }
        if (params.timeoutSeconds !== undefined) {
            search.set("timeout", String(params.timeoutSeconds));
        }
        if (params.limit !== undefined) {
            search.set("limit", String(params.limit));
        }
        if (params.allowedUpdates?.length) {
            search.set("allowed_updates", JSON.stringify(params.allowedUpdates));
        }

        return this.runApiCall({
            operation: "getUpdates",
            method: "GET",
            requestQuery: {
                offset: params.offset,
                timeout: params.timeoutSeconds,
                limit: params.limit,
                allowed_updates: params.allowedUpdates,
            },
            attributes: {
                "telegram.get_updates.offset": params.offset ?? 0,
                "telegram.get_updates.timeout_seconds": params.timeoutSeconds ?? 0,
                "telegram.get_updates.limit": params.limit ?? 0,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/getUpdates?${search.toString()}`,
                    {
                        signal: params.signal,
                    }
                );
                const parsed = await parseTelegramResponse<TelegramGetUpdatesResponse>(response);
                return {
                    parsedBody: parsed,
                    result: parsed.result,
                };
            },
            responseAttributes: (result) => ({
                "telegram.update.count": result.length,
            }),
        });
    }

    async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSendMessageResponse["result"]> {
        const payload: Record<string, string | number | boolean | object> = {
            chat_id: params.chatId,
            text: params.text,
            allow_sending_without_reply: true,
        };

        if (params.parseMode) {
            payload.parse_mode = params.parseMode;
        }

        if (params.replyToMessageId) {
            payload.reply_to_message_id = Number(params.replyToMessageId);
        }

        if (params.messageThreadId) {
            payload.message_thread_id = Number(params.messageThreadId);
        }
        if (params.replyMarkup) {
            payload.reply_markup = params.replyMarkup;
        }

        return this.runApiCall({
            operation: "sendMessage",
            method: "POST",
            requestBody: payload,
            attributes: {
                "telegram.chat.id": params.chatId,
                "telegram.chat.thread_id": params.messageThreadId ?? "",
                "telegram.reply_to_message_id": params.replyToMessageId ?? "",
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/sendMessage`,
                    {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                        },
                        body: JSON.stringify(payload),
                    }
                );
                const parsed = await parseTelegramResponse<TelegramSendMessageResponse>(response);
                return {
                    parsedBody: parsed,
                    result: parsed.result,
                };
            },
            responseAttributes: (result) => ({
                "telegram.sent_message.id": String(result.message_id),
                "telegram.chat.id": String(result.chat.id),
                "telegram.chat.thread_id": result.message_thread_id
                    ? String(result.message_thread_id)
                    : "",
            }),
        });
    }

    async sendVoice(params: TelegramSendVoiceParams): Promise<TelegramSendMessageResponse["result"]> {
        const fileName = basename(params.voicePath);
        const mimeType = params.mimeType ?? detectVoiceMimeType(params.voicePath);
        const voiceFile = new Blob([await readFile(params.voicePath)], {
            type: mimeType,
        });
        const form = new FormData();
        form.set("chat_id", params.chatId);
        form.set("voice", voiceFile, fileName);
        form.set("allow_sending_without_reply", "true");

        if (params.replyToMessageId) {
            form.set("reply_to_message_id", params.replyToMessageId);
        }

        if (params.messageThreadId) {
            form.set("message_thread_id", params.messageThreadId);
        }

        if (params.caption) {
            form.set("caption", params.caption);
        }

        if (params.parseMode) {
            form.set("parse_mode", params.parseMode);
        }

        return this.runApiCall({
            operation: "sendVoice",
            method: "POST",
            requestBody: {
                chat_id: params.chatId,
                voice: fileName,
                mime_type: mimeType,
                allow_sending_without_reply: true,
                reply_to_message_id: params.replyToMessageId ?? "",
                message_thread_id: params.messageThreadId ?? "",
                caption: params.caption ?? "",
                parse_mode: params.parseMode ?? "",
            },
            attributes: {
                "telegram.chat.id": params.chatId,
                "telegram.chat.thread_id": params.messageThreadId ?? "",
                "telegram.reply_to_message_id": params.replyToMessageId ?? "",
                "telegram.voice.file_name": fileName,
                "telegram.voice.mime_type": mimeType,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/sendVoice`,
                    {
                        method: "POST",
                        body: form,
                    }
                );
                const parsed = await parseTelegramResponse<TelegramSendMessageResponse>(response);
                return {
                    parsedBody: parsed,
                    result: parsed.result,
                };
            },
            responseAttributes: (result) => ({
                "telegram.sent_message.id": String(result.message_id),
                "telegram.chat.id": String(result.chat.id),
                "telegram.chat.thread_id": result.message_thread_id
                    ? String(result.message_thread_id)
                    : "",
            }),
        });
    }

    async sendChatAction(params: TelegramSendChatActionParams): Promise<void> {
        const payload: Record<string, string | number> = {
            chat_id: params.chatId,
            action: params.action,
        };

        if (params.messageThreadId) {
            payload.message_thread_id = Number(params.messageThreadId);
        }

        await this.runApiCall({
            operation: "sendChatAction",
            method: "POST",
            requestBody: payload,
            attributes: {
                "telegram.chat.id": params.chatId,
                "telegram.chat.thread_id": params.messageThreadId ?? "",
                "telegram.chat.action": params.action,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/sendChatAction`,
                    {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                        },
                        body: JSON.stringify(payload),
                    }
                );

                const parsed = await parseTelegramResponse<{ ok: boolean; result: true }>(response);
                return {
                    parsedBody: parsed,
                    result: undefined,
                };
            },
        });
    }

    async editMessageText(params: TelegramEditMessageTextParams): Promise<TelegramMessage> {
        const payload: Record<string, string | number | object> = {
            chat_id: params.chatId,
            message_id: Number(params.messageId),
            text: params.text,
        };

        if (params.parseMode) {
            payload.parse_mode = params.parseMode;
        }

        if (params.replyMarkup) {
            payload.reply_markup = params.replyMarkup;
        }

        return this.runApiCall({
            operation: "editMessageText",
            method: "POST",
            requestBody: payload,
            attributes: {
                "telegram.chat.id": params.chatId,
                "telegram.message.id": params.messageId,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/editMessageText`,
                    {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                        },
                        body: JSON.stringify(payload),
                    }
                );
                const parsed = await parseTelegramResponse<TelegramSendMessageResponse>(response);
                return {
                    parsedBody: parsed,
                    result: parsed.result,
                };
            },
            responseAttributes: (result) => ({
                "telegram.edited_message.id": String(result.message_id),
                "telegram.chat.id": String(result.chat.id),
            }),
        });
    }

    async answerCallbackQuery(params: TelegramAnswerCallbackQueryParams): Promise<void> {
        const payload: Record<string, string | boolean> = {
            callback_query_id: params.callbackQueryId,
        };

        if (params.text) {
            payload.text = params.text;
        }

        if (params.showAlert !== undefined) {
            payload.show_alert = params.showAlert;
        }

        await this.runApiCall({
            operation: "answerCallbackQuery",
            method: "POST",
            requestBody: payload,
            attributes: {
                "telegram.callback_query.id": params.callbackQueryId,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/answerCallbackQuery`,
                    {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                        },
                        body: JSON.stringify(payload),
                    }
                );
                const parsed = await parseTelegramResponse<{ ok: boolean; result: true }>(response);
                return {
                    parsedBody: parsed,
                    result: undefined,
                };
            },
        });
    }

    async getFile(fileId: string): Promise<{ file_path: string }> {
        const search = new URLSearchParams({ file_id: fileId });
        return this.runApiCall({
            operation: "getFile",
            method: "GET",
            requestQuery: Object.fromEntries(search),
            attributes: {
                "telegram.file.id": fileId,
            },
            execute: async () => {
                const response = await this.fetchImpl(
                    `${this.apiBaseUrl}/bot${this.options.botToken}/getFile?${search.toString()}`
                );
                const parsed = await parseTelegramResponse<TelegramGetFileResponse>(response);
                const filePath = parsed.result?.file_path;
                if (!filePath) {
                    throw new Error(`getFile returned no file_path for file_id=${fileId}`);
                }
                return {
                    parsedBody: parsed,
                    result: { file_path: filePath },
                };
            },
        });
    }

    getFileDownloadUrl(filePath: string): string {
        return `${this.apiBaseUrl}/file/bot${this.options.botToken}/${filePath}`;
    }
}
