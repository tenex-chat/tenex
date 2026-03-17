import type { InboundEnvelope, PrincipalRef } from "@/events/runtime/InboundEnvelope";
import { getIdentityBindingStore } from "@/services/identity";
import {
    createTelegramChannelId,
    createTelegramNativeMessageId,
} from "@/services/telegram/telegram-identifiers";
import type {
    TelegramGatewayBinding,
    TelegramInboundEnvelopeResult,
    TelegramMessage,
    TelegramUpdate,
} from "@/services/telegram/types";
import { NDKKind } from "@/nostr/kinds";

function normalizeMessage(update: TelegramUpdate): TelegramMessage | undefined {
    return update.message ?? update.edited_message;
}

function getTelegramDisplayName(message: TelegramMessage): string | undefined {
    const user = message.from;
    if (!user) {
        return undefined;
    }

    const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return fullName || user.username;
}

function toRecipient(agentPubkey: string, agentName: string): PrincipalRef {
    return {
        id: `nostr:${agentPubkey}`,
        transport: "nostr",
        linkedPubkey: agentPubkey,
        displayName: agentName,
        kind: "agent",
    };
}

export class TelegramInboundAdapter {
    toEnvelope(params: {
        update: TelegramUpdate;
        binding: TelegramGatewayBinding;
        projectBinding: string;
        replyToNativeMessageId?: string;
    }): TelegramInboundEnvelopeResult {
        const message = normalizeMessage(params.update);
        if (!message?.from) {
            throw new Error("Telegram update missing message.from");
        }

        const principalId = `telegram:user:${message.from.id}`;
        const identityBinding = getIdentityBindingStore().getBinding(principalId);
        const content = message.text?.trim() || message.caption?.trim();
        if (!content) {
            throw new Error("Telegram update does not contain textual content");
        }

        const envelope: InboundEnvelope = {
            transport: "telegram",
            principal: {
                id: principalId,
                transport: "telegram",
                linkedPubkey: identityBinding?.linkedPubkey,
                displayName: getTelegramDisplayName(message),
                username: message.from.username,
                kind: "human",
            },
            channel: {
                id: createTelegramChannelId(message.chat.id, message.message_thread_id),
                transport: "telegram",
                kind: message.chat.type === "private"
                    ? "dm"
                    : (message.message_thread_id ? "topic" : "group"),
                projectBinding: params.projectBinding,
            },
            message: {
                id: `telegram:${createTelegramNativeMessageId(message.chat.id, message.message_id)}`,
                transport: "telegram",
                nativeId: createTelegramNativeMessageId(message.chat.id, message.message_id),
                replyToId: params.replyToNativeMessageId
                    ? `telegram:${params.replyToNativeMessageId}`
                    : undefined,
            },
            recipients: [
                toRecipient(params.binding.agent.pubkey, params.binding.agent.name),
            ],
            content,
            occurredAt: message.date,
            capabilities: [
                "telegram-bot",
                message.chat.type === "private" ? "telegram-dm" : "telegram-group",
            ],
            metadata: {
                eventKind: NDKKind.Text,
                eventTagCount: 4,
            },
        };

        return {
            envelope,
            binding: params.binding,
            normalizedMessage: message,
        };
    }
}
