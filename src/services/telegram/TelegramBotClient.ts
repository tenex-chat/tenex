import type {
    TelegramGetMeResponse,
    TelegramGetUpdatesResponse,
    TelegramSendChatActionParams,
    TelegramSendMessageParams,
    TelegramSendMessageResponse,
} from "@/services/telegram/types";

interface TelegramBotClientOptions {
    botToken: string;
    apiBaseUrl?: string;
    fetchImpl?: typeof fetch;
}

function normalizeApiBaseUrl(apiBaseUrl: string | undefined): string {
    return (apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
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

export class TelegramBotClient {
    private readonly apiBaseUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly options: TelegramBotClientOptions) {
        this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    async getMe(): Promise<TelegramGetMeResponse["result"]> {
        const response = await this.fetchImpl(
            `${this.apiBaseUrl}/bot${this.options.botToken}/getMe`
        );
        const parsed = await parseTelegramResponse<TelegramGetMeResponse>(response);
        return parsed.result;
    }

    async getUpdates(params: {
        offset?: number;
        timeoutSeconds?: number;
        limit?: number;
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

        const response = await this.fetchImpl(
            `${this.apiBaseUrl}/bot${this.options.botToken}/getUpdates?${search.toString()}`,
            {
                signal: params.signal,
            }
        );
        const parsed = await parseTelegramResponse<TelegramGetUpdatesResponse>(response);
        return parsed.result;
    }

    async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSendMessageResponse["result"]> {
        const payload: Record<string, string | number | boolean> = {
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
        return parsed.result;
    }

    async sendChatAction(params: TelegramSendChatActionParams): Promise<void> {
        const payload: Record<string, string | number> = {
            chat_id: params.chatId,
            action: params.action,
        };

        if (params.messageThreadId) {
            payload.message_thread_id = Number(params.messageThreadId);
        }

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

        await parseTelegramResponse<{ ok: boolean; result: true }>(response);
    }
}
