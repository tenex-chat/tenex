import type { RuntimeAgentRef } from "@/events/runtime/RuntimeAgent";
import type { EventContext } from "@/nostr/types";
import { renderTelegramMessage } from "@/services/telegram/telegram-message-renderer";
import { logger } from "@/utils/logger";
import { parseTelegramChannelId } from "@/services/telegram/telegram-identifiers";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";

function getTagValue(event: EventContext["triggeringEvent"], tagName: string): string | undefined {
    if (typeof event.tagValue === "function") {
        return event.tagValue(tagName);
    }

    return event.tags.find((tag) => tag[0] === tagName)?.[1];
}

function isTelegramContext(context: EventContext): boolean {
    return getTagValue(context.triggeringEvent, "transport") === "telegram" ||
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

        const channelId = getTagValue(context.triggeringEvent, "channel");
        const telegramChannel = channelId ? parseTelegramChannelId(channelId) : undefined;
        const telegramChatId = getTagValue(context.triggeringEvent, "telegram-chat-id") ??
            telegramChannel?.chatId;
        const telegramMessageId = getTagValue(context.triggeringEvent, "telegram-message-id");
        const telegramThreadId = getTagValue(context.triggeringEvent, "telegram-thread-id") ??
            telegramChannel?.messageThreadId;

        if (!telegramChatId) {
            logger.warn("[TelegramDeliveryService] Missing telegram chat id on triggering event", {
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
