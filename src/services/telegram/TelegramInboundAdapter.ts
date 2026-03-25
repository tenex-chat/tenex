import type {
    InboundEnvelope,
    PrincipalRef,
    TelegramTransportMetadata,
} from "@/events/runtime/InboundEnvelope";
import { getIdentityBindingStore } from "@/services/identity";
import {
    createTelegramChannelId,
    createTelegramNativeMessageId,
} from "@/utils/telegram-identifiers";
import type {
    TelegramBotIdentity,
    TelegramGatewayBinding,
    TelegramInboundEnvelopeResult,
    TelegramMessage,
    TelegramUpdate,
} from "@/services/telegram/types";
import { NDKKind } from "@/nostr/kinds";
import { buildTelegramTransportMetadata } from "@/telemetry/TelegramTelemetry";
import { normalizeTelegramMessage } from "@/services/telegram/telegram-gateway-utils";

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

function buildContentWithMedia(
    textContent: string,
    mediaInfo?: { localPath: string; type: string; duration?: number; fileName?: string }
): string {
    if (!mediaInfo) return textContent;

    let mediaTag: string;
    switch (mediaInfo.type) {
        case "voice":
            mediaTag = `[voice message: ${mediaInfo.localPath}${mediaInfo.duration ? `, duration: ${mediaInfo.duration}s` : ""}]`;
            break;
        case "audio":
            mediaTag = `[audio: ${mediaInfo.localPath}${mediaInfo.duration ? `, duration: ${mediaInfo.duration}s` : ""}]`;
            break;
        case "document":
            mediaTag = `[document: ${mediaInfo.fileName ? `${mediaInfo.fileName} — ` : ""}${mediaInfo.localPath}]`;
            break;
        case "video":
            mediaTag = `[video: ${mediaInfo.localPath}${mediaInfo.duration ? `, duration: ${mediaInfo.duration}s` : ""}]`;
            break;
        case "photo":
            mediaTag = `[photo: ${mediaInfo.localPath}]`;
            break;
        default:
            mediaTag = `[attachment: ${mediaInfo.localPath}]`;
    }

    return textContent ? `${textContent}\n${mediaTag}` : mediaTag;
}

export class TelegramInboundAdapter {
    toEnvelope(params: {
        update: TelegramUpdate;
        binding: TelegramGatewayBinding;
        projectBinding: string;
        replyToNativeMessageId?: string;
        botIdentity?: TelegramBotIdentity;
        mediaInfo?: { localPath: string; type: string; duration?: number; fileName?: string };
        transportMetadata?: TelegramTransportMetadata;
    }): TelegramInboundEnvelopeResult {
        const message = normalizeTelegramMessage(params.update);
        if (!message?.from) {
            throw new Error("Telegram update missing message.from");
        }

        const principalId = `telegram:user:${message.from.id}`;
        const identityBinding = getIdentityBindingStore().getBinding(principalId);
        const textContent = message.text?.trim() || message.caption?.trim() || "";
        const content = buildContentWithMedia(textContent, params.mediaInfo);
        if (!content) {
            throw new Error("Telegram update does not contain processable content");
        }
        const transportMetadata = params.transportMetadata ??
            buildTelegramTransportMetadata(
                params.update,
                params.botIdentity
            );
        const equivalentTagCount =
            1 +
            (params.projectBinding ? 1 : 0) +
            (params.replyToNativeMessageId ? 1 : 0);

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
                eventTagCount: equivalentTagCount,
                transport: transportMetadata ? { telegram: transportMetadata } : undefined,
            },
        };

        return {
            envelope,
            binding: params.binding,
            normalizedMessage: message,
        };
    }
}
