import type { TelegramTransportMetadata } from "@/events/runtime/InboundEnvelope";
import type {
    TelegramBotIdentity,
    TelegramMessage,
    TelegramUpdate,
} from "@/services/telegram/types";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

function getMessage(update: TelegramUpdate): TelegramMessage | undefined {
    return update.message ?? update.edited_message ?? update.callback_query?.message;
}

export function getTelegramMessageContent(message: Pick<TelegramMessage, "text" | "caption">): string {
    return message.text?.trim() || message.caption?.trim() || "";
}

export function getTelegramUpdateContent(update: TelegramUpdate): string {
    const message = getMessage(update);
    if (message) {
        return getTelegramMessageContent(message);
    }

    return update.callback_query?.data?.trim() || "";
}

export function buildTelegramTransportMetadata(
    update: TelegramUpdate,
    botIdentity?: TelegramBotIdentity,
    context?: Pick<
        TelegramTransportMetadata,
        "administrators" | "chatTitle" | "chatUsername" | "memberCount" | "seenParticipants" | "topicTitle"
    >
): TelegramTransportMetadata | undefined {
    const message = getMessage(update);
    const sender = update.callback_query?.from ?? message?.from;
    if (!message || !sender) {
        return undefined;
    }

    return {
        updateId: update.update_id,
        chatId: String(message.chat.id),
        messageId: String(message.message_id),
        threadId: message.message_thread_id !== undefined
            ? String(message.message_thread_id)
            : undefined,
        chatType: message.chat.type,
        isEditedMessage: Boolean(update.edited_message),
        senderUserId: String(sender.id),
        chatTitle: (context?.chatTitle ?? message.chat.title?.trim()) || undefined,
        topicTitle: context?.topicTitle,
        chatUsername: (context?.chatUsername ?? message.chat.username?.trim()) || undefined,
        memberCount: context?.memberCount,
        administrators: context?.administrators,
        seenParticipants: context?.seenParticipants,
        botId: botIdentity ? String(botIdentity.id) : undefined,
        botUsername: botIdentity?.username,
    };
}

export function buildTelegramUpdateAttributes(params: {
    update: TelegramUpdate;
    source: string;
    projectId?: string;
    projectTitle?: string;
    agentSlug?: string;
    agentPubkey?: string;
    botIdentity?: TelegramBotIdentity;
}): Record<string, boolean | number | string> {
    const transport = buildTelegramTransportMetadata(params.update, params.botIdentity);
    const content = getTelegramUpdateContent(params.update);

    return {
        "runtime.transport": "telegram",
        "telegram.update.source": params.source,
        "telegram.update.id": params.update.update_id,
        "telegram.callback_query.id": params.update.callback_query?.id ?? "",
        "telegram.callback_query.data": params.update.callback_query?.data ?? "",
        "telegram.message.id": transport?.messageId ?? "",
        "telegram.message.content": content,
        "telegram.message.is_edited": transport?.isEditedMessage ?? false,
        "telegram.chat.id": transport?.chatId ?? "",
        "telegram.chat.type": transport?.chatType ?? "",
        "telegram.chat.title": transport?.chatTitle ?? "",
        "telegram.chat.username": transport?.chatUsername ?? "",
        "telegram.chat.thread_id": transport?.threadId ?? "",
        "telegram.chat.member_count": transport?.memberCount ?? 0,
        "telegram.chat.admin_count": transport?.administrators?.length ?? 0,
        "telegram.chat.seen_participant_count": transport?.seenParticipants?.length ?? 0,
        "telegram.sender.id": transport?.senderUserId ?? "",
        "telegram.bot.id": transport?.botId ?? "",
        "telegram.bot.username": transport?.botUsername ?? "",
        "project.id": params.projectId ?? "",
        "project.title": params.projectTitle ?? "",
        "agent.slug": params.agentSlug ?? "",
        "agent.pubkey": params.agentPubkey ?? "",
    };
}

export function withActiveTraceLogFields(
    context: Record<string, unknown> = {}
): Record<string, unknown> {
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (!spanContext ||
        spanContext.traceId === INVALID_TRACE_ID ||
        spanContext.spanId === INVALID_SPAN_ID
    ) {
        return context;
    }

    return {
        ...context,
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
    };
}

export async function runWithTelegramUpdateSpan<T>(
    params: {
        update: TelegramUpdate;
        source: string;
        projectId?: string;
        projectTitle?: string;
        agentSlug?: string;
        agentPubkey?: string;
        botIdentity?: TelegramBotIdentity;
    },
    fn: () => Promise<T>
): Promise<T> {
    return trace.getTracer("tenex.telegram").startActiveSpan(
        "tenex.telegram.update",
        {
            attributes: buildTelegramUpdateAttributes(params),
        },
        async (span) => {
            try {
                const result = await fn();
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: error instanceof Error ? error.message : String(error),
                });
                throw error;
            } finally {
                span.end();
            }
        }
    );
}
