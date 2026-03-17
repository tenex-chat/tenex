import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type {
    RuntimeAgentRef,
    TelegramAgentConfig,
    TelegramChatBinding,
} from "@/events/runtime/RuntimeAgent";

export interface TelegramUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
}

export interface TelegramChat {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
}

export interface TelegramMessage {
    message_id: number;
    date: number;
    chat: TelegramChat;
    from?: TelegramUser;
    text?: string;
    caption?: string;
    message_thread_id?: number;
    reply_to_message?: {
        message_id: number;
    };
}

export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
}

export interface TelegramGetUpdatesResponse {
    ok: boolean;
    result: TelegramUpdate[];
}

export interface TelegramSendMessageResponse {
    ok: boolean;
    result: TelegramMessage;
}

export interface TelegramBotIdentity {
    id: number;
    is_bot: true;
    first_name: string;
    username?: string;
}

export interface TelegramGetMeResponse {
    ok: boolean;
    result: TelegramBotIdentity;
}

export interface TelegramSendMessageParams {
    chatId: string;
    text: string;
    parseMode?: "HTML" | "MarkdownV2";
    replyToMessageId?: string;
    messageThreadId?: string;
}

export interface TelegramSendChatActionParams {
    chatId: string;
    action: "typing";
    messageThreadId?: string;
}

export interface TelegramGatewayBinding {
    agent: RuntimeAgentRef;
    config: TelegramAgentConfig;
    chatBindings: TelegramChatBinding[];
}

export interface TelegramInboundEnvelopeResult {
    envelope: InboundEnvelope;
    binding: TelegramGatewayBinding;
    normalizedMessage: TelegramMessage;
}
