import type { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import type { TelegramChatBinding } from "@/agents/types/storage";
import type {
    TelegramMessage,
    TelegramUpdate,
} from "@/services/telegram/types";

export function normalizeTelegramMessage(update: TelegramUpdate): TelegramMessage | undefined {
    return update.message ?? update.edited_message;
}

export function normalizeTelegramChatId(chatId: string | number): string {
    return String(chatId);
}

export function normalizeTelegramTopicId(topicId: string | number | undefined): string | undefined {
    return topicId === undefined ? undefined : String(topicId);
}

export function isTelegramAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTextualTelegramMessage(message: TelegramMessage): boolean {
    return Boolean(message.text?.trim() || message.caption?.trim());
}

export function isSupportedTelegramChatType(message: TelegramMessage): boolean {
    return message.chat.type === "private" ||
        message.chat.type === "group" ||
        message.chat.type === "supergroup";
}

export function matchesTelegramChatBinding(
    chatBindings: TelegramChatBinding[] | undefined,
    chatId: string,
    topicId?: string
): boolean {
    const bindings = chatBindings ?? [];
    if (bindings.length === 0) {
        return false;
    }

    return bindings.some((chatBinding) => {
        if (chatBinding.chatId !== chatId) {
            return false;
        }

        if (!chatBinding.topicId) {
            return true;
        }

        return chatBinding.topicId === topicId;
    });
}

export async function sendUnauthorizedTelegramConfigReply(
    client: TelegramBotClient,
    message: TelegramMessage
): Promise<void> {
    await client.sendMessage({
        chatId: String(message.chat.id),
        text: "You are not allowed to change this agent's Telegram config.",
        replyToMessageId: String(message.message_id),
        messageThreadId: normalizeTelegramTopicId(message.message_thread_id),
    });
}

export async function skipTelegramBacklog(
    client: TelegramBotClient,
    pollLimit: number
): Promise<{ nextOffset?: number; skippedCount: number }> {
    let nextOffset: number | undefined;
    let skippedCount = 0;

    while (true) {
        const updates = await client.getUpdates({
            offset: nextOffset,
            timeoutSeconds: 0,
            limit: pollLimit,
            allowedUpdates: ["message", "edited_message", "callback_query"],
        });

        if (updates.length === 0) {
            return { nextOffset, skippedCount };
        }

        skippedCount += updates.length;
        const lastUpdate = updates[updates.length - 1];
        nextOffset = lastUpdate ? lastUpdate.update_id + 1 : nextOffset;
    }
}

export async function runTelegramPollingLoop(params: {
    shouldContinue: () => boolean;
    client: TelegramBotClient;
    getNextOffset: () => number | undefined;
    setNextOffset: (offset: number) => void;
    assignAbortController: (abortController: AbortController) => void;
    releaseAbortController: (abortController: AbortController) => void;
    timeoutSeconds: number;
    pollLimit: number;
    errorBackoffMs: number;
    processUpdate: (update: TelegramUpdate) => Promise<void>;
    onProcessUpdateError: (update: TelegramUpdate, error: unknown) => void;
    onLoopError: (error: unknown) => void;
}): Promise<void> {
    while (params.shouldContinue()) {
        const abortController = new AbortController();
        params.assignAbortController(abortController);

        try {
            const updates = await params.client.getUpdates({
                offset: params.getNextOffset(),
                timeoutSeconds: params.timeoutSeconds,
                limit: params.pollLimit,
                allowedUpdates: ["message", "edited_message", "callback_query"],
                signal: abortController.signal,
            });

            for (const update of updates) {
                if (!params.shouldContinue()) {
                    break;
                }

                try {
                    await params.processUpdate(update);
                } catch (error) {
                    params.onProcessUpdateError(update, error);
                } finally {
                    params.setNextOffset(update.update_id + 1);
                }
            }
        } catch (error) {
            if (!params.shouldContinue() || isTelegramAbortError(error)) {
                break;
            }

            params.onLoopError(error);
            await sleep(params.errorBackoffMs);
        } finally {
            params.releaseAbortController(abortController);
        }
    }
}
