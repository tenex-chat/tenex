import type {
    InboundEnvelope,
    TelegramChatAdministratorMetadata,
    TelegramSeenParticipantMetadata,
} from "@/events/runtime/InboundEnvelope";
import type { PromptFragment } from "../core/types";

const MAX_ADMINS = 10;
const MAX_SEEN_PARTICIPANTS = 12;

function formatHandle(username: string | undefined): string {
    return username ? ` (@${username})` : "";
}

function formatIdentityLabel(
    displayName: string | undefined,
    username: string | undefined,
    fallback: string
): string {
    const base = displayName ?? username ?? fallback;
    if (!username || base === username) {
        return base;
    }
    return `${base}${formatHandle(username)}`;
}

function formatAdministrator(administrator: TelegramChatAdministratorMetadata): string {
    const customTitle = administrator.customTitle ? ` [${administrator.customTitle}]` : "";
    return `${formatIdentityLabel(
        administrator.displayName,
        administrator.username,
        administrator.userId
    )}${customTitle}`;
}

function formatParticipant(participant: TelegramSeenParticipantMetadata): string {
    return formatIdentityLabel(
        participant.displayName,
        participant.username,
        participant.userId
    );
}

function describeChatScope(envelope: InboundEnvelope): string {
    if (envelope.channel.kind === "topic") {
        return "Telegram topic";
    }

    if (envelope.channel.kind === "group") {
        return "Telegram group";
    }

    return "Telegram direct message";
}

export const telegramChatContextFragment: PromptFragment<{
    triggeringEnvelope?: InboundEnvelope;
}> = {
    id: "telegram-chat-context",
    priority: 5,
    template: ({ triggeringEnvelope }) => {
        const telegram = triggeringEnvelope?.metadata.transport?.telegram;
        if (!triggeringEnvelope || !telegram) {
            return "";
        }

        const lines = [
            "## Telegram Chat Context",
            `- Context: ${describeChatScope(triggeringEnvelope)}`,
        ];

        if (telegram.chatTitle) {
            lines.push(`- Chat title: ${telegram.chatTitle}`);
        }

        if (telegram.chatUsername) {
            lines.push(`- Chat username: @${telegram.chatUsername}`);
        }

        lines.push(
            `- Current sender: ${formatIdentityLabel(
                triggeringEnvelope.principal.displayName,
                triggeringEnvelope.principal.username,
                telegram.senderUserId
            )}`
        );

        if (telegram.threadId && triggeringEnvelope.channel.kind === "topic") {
            if (telegram.topicTitle) {
                lines.push(`- Topic: ${telegram.topicTitle}`);
            }
            lines.push(`- Topic/thread ID: ${telegram.threadId}`);
        }

        if (telegram.memberCount !== undefined) {
            lines.push(`- Member count (Telegram API snapshot): ${telegram.memberCount}`);
        }

        if ((telegram.administrators?.length ?? 0) > 0) {
            lines.push(
                `- Administrators (Telegram API snapshot): ${
                    telegram.administrators
                        ?.slice(0, MAX_ADMINS)
                        .map(formatAdministrator)
                        .join(", ")
                }`
            );
        }

        if ((telegram.seenParticipants?.length ?? 0) > 0) {
            lines.push(
                `- Recently seen participants (TENEX-local observations): ${
                    telegram.seenParticipants
                        ?.slice(0, MAX_SEEN_PARTICIPANTS)
                        .map(formatParticipant)
                        .join(", ")
                }`
            );
        }

        return lines.join("\n");
    },
};
