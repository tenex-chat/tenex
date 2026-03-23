import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { toNativeId } from "@/events/runtime/envelope-classifier";
import {
    parseTelegramChannelId,
    parseTelegramNativeMessageId,
} from "@/utils/telegram-identifiers";

export interface DiagnosticEventSnapshot {
    id: string;
    senderId: string;
    senderLinkedPubkey?: string;
    content: string;
    tags: string[][];
}

export function buildDiagnosticEventSnapshot(
    envelope: InboundEnvelope
): DiagnosticEventSnapshot {
    const tags: string[][] = [];

    if (envelope.channel.projectBinding) {
        tags.push(["a", envelope.channel.projectBinding]);
    }

    if (envelope.message.replyToId) {
        tags.push(["e", toNativeId(envelope.message.replyToId)]);
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
        senderId: envelope.principal.id,
        senderLinkedPubkey: envelope.principal.linkedPubkey,
        content: envelope.content,
        tags,
    };
}

export function getDiagnosticTagValue(
    snapshot: DiagnosticEventSnapshot,
    tagName: string
): string | undefined {
    return snapshot.tags.find((tag) => tag[0] === tagName)?.[1];
}
