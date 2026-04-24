import type { AgentInstance } from "@/agents/types";
import { getTransportBindingStore } from "@/services/ingress/TransportBindingStoreService";
import { getIdentityBindingStore } from "@/services/identity";
import { getTelegramChatContextStore } from "@/services/telegram/TelegramChatContextStoreService";
import { parseTelegramChannelId } from "@/utils/telegram-identifiers";
import type { ProjectDTag } from "@/types/project-ids";

export interface ChannelBindingEntry {
    channelId: string;
    type: "dm" | "group" | "topic";
    description: string;
}

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

function describeTelegramChannelBinding(
    projectId: string,
    agentPubkey: string,
    channelId: string
): { type: "dm" | "group" | "topic"; description: string } | undefined {
    const parsed = parseTelegramChannelId(channelId);
    if (!parsed) {
        return undefined;
    }

    if (!parsed.chatId.startsWith("-")) {
        const identity = getIdentityBindingStore().getBinding(`telegram:user:${parsed.chatId}`);
        const description = `DM with ${formatIdentityLabel(
            identity?.displayName,
            identity?.username,
            parsed.chatId
        )}`;
        return { type: "dm", description };
    }

    const chatContext = getTelegramChatContextStore().getContext(projectId, agentPubkey, channelId);
    if (!chatContext?.chatTitle && !chatContext?.chatUsername) {
        if (parsed.messageThreadId) {
            return { type: "topic", description: "Telegram topic" };
        }
        return { type: "group", description: "Telegram chat" };
    }

    const title = chatContext.chatTitle
        ? `"${chatContext.chatTitle}"`
        : chatContext.chatUsername
          ? `@${chatContext.chatUsername}`
          : undefined;

    if (!title) {
        if (parsed.messageThreadId) {
            return { type: "topic", description: "Telegram topic" };
        }
        return { type: "group", description: "Telegram chat" };
    }

    if (parsed.messageThreadId) {
        const topicLabel = chatContext.topicTitle
            ? `'${chatContext.topicTitle}' in ${title}`
            : `topic in ${title}`;
        return { type: "topic", description: topicLabel };
    }

    return { type: "group", description: title };
}

export function buildProjectChannelBindingEntries(
    agent: AgentInstance,
    projectId: ProjectDTag
): ChannelBindingEntry[] {
    if (!agent.pubkey || !agent.telegram?.botToken) {
        return [];
    }

    const bindings = getTransportBindingStore().listBindingsForAgentProject(
        agent.pubkey,
        projectId,
        "telegram"
    );

    const entries: ChannelBindingEntry[] = [];
    for (const binding of bindings) {
        const info = describeTelegramChannelBinding(projectId, agent.pubkey, binding.channelId);
        if (info) {
            entries.push({
                channelId: binding.channelId,
                type: info.type,
                description: info.description,
            });
        }
    }

    return entries;
}
