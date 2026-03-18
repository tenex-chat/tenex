import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import {
    parseTelegramChannelId,
    parseTelegramNativeMessageId,
} from "@/services/telegram/telegram-identifiers";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface LegacyEventSnapshot {
    id: string;
    pubkey: string;
    content: string;
    tags: string[][];
}

function unwrapExternalMessageId(messageId: string): string {
    const separatorIndex = messageId.indexOf(":");
    return separatorIndex === -1 ? messageId : messageId.substring(separatorIndex + 1);
}

export function buildLegacyEventSnapshot(
    envelope: InboundEnvelope,
    legacyEvent?: Pick<NDKEvent, "id" | "pubkey" | "content" | "tags">
): LegacyEventSnapshot {
    if (legacyEvent) {
        return {
            id: legacyEvent.id ?? "",
            pubkey: legacyEvent.pubkey,
            content: legacyEvent.content,
            tags: [...legacyEvent.tags],
        };
    }

    const tags: string[][] = [];

    if (envelope.channel.projectBinding) {
        tags.push(["a", envelope.channel.projectBinding]);
    }

    if (envelope.message.replyToId) {
        tags.push(["e", unwrapExternalMessageId(envelope.message.replyToId)]);
    }

    for (const recipient of envelope.recipients) {
        if (recipient.linkedPubkey) {
            tags.push(["p", recipient.linkedPubkey]);
        } else {
            tags.push(["recipient-principal", recipient.id]);
        }
    }

    if (envelope.transport === "telegram") {
        const telegramChannel = parseTelegramChannelId(envelope.channel.id);
        const telegramMessage = parseTelegramNativeMessageId(envelope.message.nativeId);

        if (telegramChannel?.chatId) {
            tags.push(["telegram-chat-id", telegramChannel.chatId]);
        }

        if (telegramMessage?.messageId) {
            tags.push(["telegram-message-id", telegramMessage.messageId]);
        }

        if (telegramChannel?.messageThreadId) {
            tags.push(["telegram-thread-id", telegramChannel.messageThreadId]);
        }
    }

    return {
        id: envelope.message.nativeId,
        pubkey: envelope.principal.linkedPubkey ?? envelope.principal.id,
        content: envelope.content,
        tags,
    };
}

export function getLegacyTagValue(
    snapshot: LegacyEventSnapshot,
    tagName: string
): string | undefined {
    return snapshot.tags.find((tag) => tag[0] === tagName)?.[1];
}
