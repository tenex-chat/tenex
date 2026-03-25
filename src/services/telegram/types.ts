import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type {
    TelegramChatAdministratorMetadata,
} from "@/events/runtime/InboundEnvelope";
import type {
    RuntimeAgentRef,
} from "@/events/runtime/RuntimeAgent";
import type { TelegramAgentConfig, TelegramChatBinding } from "@/agents/types/storage";

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

export interface TelegramVoice {
    file_id: string;
    file_unique_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
}

export interface TelegramAudio {
    file_id: string;
    file_unique_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
    title?: string;
}

export interface TelegramDocument {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}

export interface TelegramPhotoSize {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
}

export interface TelegramVideo {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    duration: number;
    mime_type?: string;
    file_size?: number;
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
    voice?: TelegramVoice;
    audio?: TelegramAudio;
    document?: TelegramDocument;
    photo?: TelegramPhotoSize[];
    video?: TelegramVideo;
}

export interface TelegramGetFileResponse {
    ok: boolean;
    result: {
        file_id: string;
        file_unique_id: string;
        file_size?: number;
        file_path?: string;
    };
}

export interface TelegramInlineKeyboardButton {
    text: string;
    callback_data?: string;
}

export interface TelegramInlineKeyboardMarkup {
    inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramBotCommand {
    command: string;
    description: string;
}

export interface TelegramCallbackQuery {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
}

export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
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

export interface TelegramChatFullInfo extends TelegramChat {}

export interface TelegramChatMemberAdministrator {
    status: "administrator" | "creator" | (string & {});
    user: TelegramUser;
    custom_title?: string;
}

export interface TelegramGetMeResponse {
    ok: boolean;
    result: TelegramBotIdentity;
}

export interface TelegramGetChatResponse {
    ok: boolean;
    result: TelegramChatFullInfo;
}

export interface TelegramGetChatAdministratorsResponse {
    ok: boolean;
    result: TelegramChatMemberAdministrator[];
}

export interface TelegramGetChatMemberCountResponse {
    ok: boolean;
    result: number;
}

export interface TelegramSendMessageParams {
    chatId: string;
    text: string;
    parseMode?: "HTML" | "MarkdownV2";
    replyToMessageId?: string;
    messageThreadId?: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramSendVoiceParams {
    chatId: string;
    voicePath: string;
    mimeType?: string;
    replyToMessageId?: string;
    messageThreadId?: string;
    caption?: string;
    parseMode?: "HTML" | "MarkdownV2";
}

export interface TelegramSendChatActionParams {
    chatId: string;
    action: "typing";
    messageThreadId?: string;
}

export interface TelegramEditMessageTextParams {
    chatId: string;
    messageId: string;
    text: string;
    parseMode?: "HTML" | "MarkdownV2";
    replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramAnswerCallbackQueryParams {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
}

export interface TelegramGatewayBinding {
    agent: RuntimeAgentRef;
    config: TelegramAgentConfig;
    chatBindings: TelegramChatBinding[];
}

export interface TelegramChatContextSnapshot {
    chatTitle?: string;
    chatUsername?: string;
    memberCount?: number;
    administrators?: TelegramChatAdministratorMetadata[];
}

export type TelegramInboundMediaType = 'voice' | 'audio' | 'document' | 'photo' | 'video';

export interface TelegramInboundMediaInfo {
    localPath: string;
    type: TelegramInboundMediaType;
    duration?: number;
    fileName?: string;
}

export interface TelegramInboundEnvelopeResult {
    envelope: InboundEnvelope;
    binding: TelegramGatewayBinding;
    normalizedMessage: TelegramMessage;
}
