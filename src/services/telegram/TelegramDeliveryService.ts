import { isAbsolute } from "node:path";

import type { RuntimeAgentRef } from "@/events/runtime/RuntimeAgent";
import type { EventContext } from "@/nostr/types";
import { withActiveTraceLogFields } from "@/telemetry/TelegramTelemetry";
import { renderTelegramMessage } from "@/services/telegram/telegram-message-renderer";
import { logger } from "@/utils/logger";
import {
    parseTelegramChannelId,
    parseTelegramNativeMessageId,
} from "@/utils/telegram-identifiers";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.telegram.delivery");
const TELEGRAM_VOICE_MARKER_PATTERN = /^\s*\[\[telegram_voice:(.+?)\]\]\s*$/gm;

function isTelegramContext(context: EventContext): boolean {
    return context.triggeringEnvelope.transport === "telegram" ||
        context.completionRecipientPrincipal?.transport === "telegram";
}

function extractTelegramVoiceReply(content: string): {
    voicePath: string;
    remainingContent: string;
} | undefined {
    const matches = Array.from(content.matchAll(TELEGRAM_VOICE_MARKER_PATTERN));
    if (matches.length !== 1) {
        return undefined;
    }

    const fullMatch = matches[0]?.[0];
    const voicePath = matches[0]?.[1]?.trim();
    if (!fullMatch || !voicePath || !isAbsolute(voicePath)) {
        return undefined;
    }

    return {
        voicePath,
        remainingContent: content
            .replace(fullMatch, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
    };
}

export class TelegramDeliveryService {
    private readonly clients = new Map<string, TelegramBotClient>();

    canHandle(agent: RuntimeAgentRef, context: EventContext): boolean {
        return Boolean(agent.telegram?.botToken) && isTelegramContext(context);
    }

    async sendReply(
        agent: RuntimeAgentRef,
        context: EventContext,
        content: string
    ): Promise<void> {
        return tracer.startActiveSpan(
            "tenex.telegram.delivery.reply",
            async (span) => {
                try {
                    const telegramConfig = agent.telegram;
                    if (!telegramConfig?.botToken) {
                        span.setStatus({ code: SpanStatusCode.OK, message: "missing_bot_token" });
                        return;
                    }

                    const telegramMetadata = context.triggeringEnvelope.metadata.transport?.telegram;
                    const telegramChannel = parseTelegramChannelId(context.triggeringEnvelope.channel.id);
                    const telegramMessage = parseTelegramNativeMessageId(
                        context.triggeringEnvelope.message.nativeId
                    );
                    const telegramChatId = telegramMetadata?.chatId ??
                        telegramChannel?.chatId ??
                        telegramMessage?.chatId;
                    const telegramMessageId = telegramMetadata?.messageId ?? telegramMessage?.messageId;
                    const telegramThreadId = telegramMetadata?.threadId ?? telegramChannel?.messageThreadId;

                    span.setAttributes({
                        "agent.slug": agent.slug,
                        "conversation.id": context.conversationId,
                        "telegram.chat.id": telegramChatId ?? "",
                        "telegram.message.id": telegramMessageId ?? "",
                        "telegram.chat.thread_id": telegramThreadId ?? "",
                        "telegram.message.content": content,
                    });

                    if (!telegramChatId) {
                        logger.warn("[TelegramDeliveryService] Missing telegram chat id on triggering envelope", withActiveTraceLogFields({
                            agentSlug: agent.slug,
                            conversationId: context.conversationId,
                        }));
                        span.setStatus({ code: SpanStatusCode.OK, message: "missing_chat_id" });
                        return;
                    }

                    const client = this.getClient(telegramConfig.botToken, telegramConfig.apiBaseUrl);
                    logger.info("[TelegramDeliveryService] Sending Telegram reply", withActiveTraceLogFields({
                        agentSlug: agent.slug,
                        conversationId: context.conversationId,
                        chatId: telegramChatId,
                        messageId: telegramMessageId,
                        threadId: telegramThreadId,
                        content,
                    }));

                    const voiceReply = extractTelegramVoiceReply(content);
                    if (voiceReply) {
                        try {
                            await client.sendVoice({
                                chatId: telegramChatId,
                                voicePath: voiceReply.voicePath,
                                replyToMessageId: telegramMessageId,
                                messageThreadId: telegramThreadId,
                            });
                            span.addEvent("telegram.delivery.voice_sent", {
                                "telegram.chat.id": telegramChatId,
                                "telegram.message.id": telegramMessageId ?? "",
                                "telegram.voice.path": voiceReply.voicePath,
                            });
                        } catch (error) {
                            span.addEvent("telegram.delivery.voice_failed", {
                                "telegram.chat.id": telegramChatId,
                                "telegram.message.id": telegramMessageId ?? "",
                                "telegram.voice.path": voiceReply.voicePath,
                                "delivery.error": error instanceof Error ? error.message : String(error),
                            });
                            logger.warn("[TelegramDeliveryService] Telegram voice delivery failed", withActiveTraceLogFields({
                                agentSlug: agent.slug,
                                conversationId: context.conversationId,
                                chatId: telegramChatId,
                                messageId: telegramMessageId,
                                threadId: telegramThreadId,
                                voicePath: voiceReply.voicePath,
                                error: error instanceof Error ? error.message : String(error),
                            }));

                            if (!voiceReply.remainingContent) {
                                throw error;
                            }
                        }

                        if (voiceReply.remainingContent) {
                            await this.sendTextReply(
                                client,
                                telegramChatId,
                                telegramMessageId,
                                telegramThreadId,
                                voiceReply.remainingContent,
                                agent.slug,
                                context.conversationId
                            );
                        }
                        span.setStatus({ code: SpanStatusCode.OK });
                        return;
                    }

                    await this.sendTextReply(
                        client,
                        telegramChatId,
                        telegramMessageId,
                        telegramThreadId,
                        content,
                        agent.slug,
                        context.conversationId
                    );
                    span.setStatus({ code: SpanStatusCode.OK });
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

    private async sendTextReply(
        client: TelegramBotClient,
        telegramChatId: string,
        telegramMessageId: string | undefined,
        telegramThreadId: string | undefined,
        content: string,
        agentSlug: string,
        conversationId: string
    ): Promise<void> {
        const rendered = renderTelegramMessage(content);

        try {
            await client.sendMessage({
                chatId: telegramChatId,
                text: rendered.text,
                parseMode: rendered.parseMode,
                replyToMessageId: telegramMessageId,
                messageThreadId: telegramThreadId,
            });
        } catch (error) {
            trace.getActiveSpan()?.addEvent("telegram.delivery.html_retry", {
                "telegram.chat.id": telegramChatId,
                "telegram.message.id": telegramMessageId ?? "",
                "delivery.error": error instanceof Error ? error.message : String(error),
            });
            logger.warn("[TelegramDeliveryService] HTML rendering failed, retrying with plain text", withActiveTraceLogFields({
                agentSlug,
                conversationId,
                chatId: telegramChatId,
                messageId: telegramMessageId,
                threadId: telegramThreadId,
                error: error instanceof Error ? error.message : String(error),
            }));

            await client.sendMessage({
                chatId: telegramChatId,
                text: content,
                replyToMessageId: telegramMessageId,
                messageThreadId: telegramThreadId,
            });
        }
    }

    private getClient(botToken: string, apiBaseUrl?: string): TelegramBotClient {
        const key = `${apiBaseUrl ?? "https://api.telegram.org"}::${botToken}`;
        let client = this.clients.get(key);
        if (!client) {
            client = new TelegramBotClient({ botToken, apiBaseUrl });
            this.clients.set(key, client);
        }
        return client;
    }
}
