import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { NDKKind } from "@/nostr/kinds";
import {
    parseTelegramChannelId,
    parseTelegramNativeMessageId,
} from "@/lib/telegram-identifiers";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { createHash } from "node:crypto";

function unwrapExternalMessageId(messageId: string): string {
    const separatorIndex = messageId.indexOf(":");
    return separatorIndex === -1 ? messageId : messageId.substring(separatorIndex + 1);
}

function toLegacyPubkey(envelope: InboundEnvelope): string {
    if (envelope.principal.linkedPubkey) {
        return envelope.principal.linkedPubkey;
    }

    return createHash("sha256")
        .update(`transport-principal:${envelope.principal.id}`)
        .digest("hex");
}

export class InboundEnvelopeEventBridge {
    toEvent(envelope: InboundEnvelope): NDKEvent {
        const event = new NDKEvent();
        event.kind = envelope.metadata.eventKind ?? NDKKind.Text;
        event.pubkey = toLegacyPubkey(envelope);
        event.created_at = envelope.occurredAt;
        event.content = envelope.content;
        event.id = envelope.message.nativeId;
        event.tags = [
            ["transport", envelope.transport],
            ["principal", envelope.principal.id],
            ["channel", envelope.channel.id],
        ];

        if (envelope.channel.projectBinding) {
            event.tags.push(["a", envelope.channel.projectBinding]);
        }

        if (envelope.message.replyToId) {
            event.tags.push(["e", unwrapExternalMessageId(envelope.message.replyToId)]);
        }

        if (envelope.transport === "telegram") {
            const telegramChannel = parseTelegramChannelId(envelope.channel.id);
            const telegramMessage = parseTelegramNativeMessageId(envelope.message.nativeId);

            if (telegramChannel?.chatId) {
                event.tags.push(["telegram-chat-id", telegramChannel.chatId]);
            }

            if (telegramMessage?.messageId) {
                event.tags.push(["telegram-message-id", telegramMessage.messageId]);
            }

            if (telegramChannel?.messageThreadId) {
                event.tags.push(["telegram-thread-id", telegramChannel.messageThreadId]);
            }
        }

        for (const recipient of envelope.recipients) {
            if (recipient.linkedPubkey) {
                event.tags.push(["p", recipient.linkedPubkey]);
                continue;
            }

            event.tags.push(["recipient-principal", recipient.id]);
        }

        return event;
    }
}
