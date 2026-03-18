import type { RuntimeAgentRef } from "@/events/runtime/RuntimeAgent";
import type { EventContext } from "@/nostr/types";
import { renderTelegramMessage } from "@/services/telegram/telegram-message-renderer";
import { logger } from "@/utils/logger";
import {
    parseTelegramChannelId,
    parseTelegramNativeMessageId,
} from "@/services/telegram/telegram-identifiers";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";

function isTelegramContext(context: EventContext): boolean {
    return context.triggeringEnvelope.transport === "telegram" ||
        context.completionRecipientPrincipal?.transport === "telegram";
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
        const telegramConfig = agent.telegram;
        if (!telegramConfig?.botToken) {
            return;
        }

        const telegramChannel = parseTelegramChannelId(context.triggeringEnvelope.channel.id);
        const telegramMessage = parseTelegramNativeMessageId(
            context.triggeringEnvelope.message.nativeId
        );
        const telegramChatId = telegramChannel?.chatId ?? telegramMessage?.chatId;
        const telegramMessageId = telegramMessage?.messageId;
        const telegramThreadId = telegramChannel?.messageThreadId;

        if (!telegramChatId) {
            logger.warn("[TelegramDeliveryService] Missing telegram chat id on triggering envelope", {
                agentSlug: agent.slug,
                conversationId: context.conversationId,
            });
            return;
        }

        const client = this.getClient(telegramConfig.botToken, telegramConfig.apiBaseUrl);
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
            logger.warn("[TelegramDeliveryService] HTML rendering failed, retrying with plain text", {
                agentSlug: agent.slug,
                conversationId: context.conversationId,
                error: error instanceof Error ? error.message : String(error),
            });

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
