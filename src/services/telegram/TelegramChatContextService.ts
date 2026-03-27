import type {
    TelegramChatAdministratorMetadata,
    TelegramSeenParticipantMetadata,
} from "@/events/runtime/InboundEnvelope";
import {
    type TelegramChatContextStore,
    getTelegramChatContextStore,
    type TelegramChatContextRecord,
} from "@/services/telegram/TelegramChatContextStoreService";
import { logger } from "@/utils/logger";
import type {
    TelegramBotClient,
} from "@/services/telegram/TelegramBotClient";
import type {
    TelegramChatMemberAdministrator,
    TelegramMessage,
    TelegramUser,
} from "@/services/telegram/types";

const DEFAULT_API_SYNC_TTL_MS = 5 * 60 * 1000;
const MAX_SEEN_PARTICIPANTS = 25;

interface TelegramChatContextServiceOptions {
    store?: Pick<TelegramChatContextStore, "getContext" | "listContexts" | "rememberContext">;
    apiSyncTtlMs?: number;
    now?: () => number;
}

function normalizeChatId(chatId: string | number): string {
    return String(chatId);
}

function normalizeTopicId(topicId: string | number | undefined): string | undefined {
    return topicId === undefined ? undefined : String(topicId);
}

function trimOrUndefined(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function getUserDisplayName(user: Pick<TelegramUser, "first_name" | "last_name" | "username">): string | undefined {
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return trimOrUndefined(fullName) ?? trimOrUndefined(user.username);
}

function toSeenParticipant(
    user: TelegramUser | undefined,
    seenAt: number
): TelegramSeenParticipantMetadata | undefined {
    if (!user || user.is_bot || user.id === undefined || user.id === null) {
        return undefined;
    }

    return {
        userId: String(user.id),
        displayName: getUserDisplayName(user),
        username: trimOrUndefined(user.username),
        lastSeenAt: seenAt,
    };
}

function upsertSeenParticipants(
    participants: TelegramSeenParticipantMetadata[],
    nextParticipant: TelegramSeenParticipantMetadata | undefined
): TelegramSeenParticipantMetadata[] {
    const merged = new Map<string, TelegramSeenParticipantMetadata>();

    for (const participant of participants) {
        merged.set(participant.userId, participant);
    }

    if (nextParticipant) {
        const existing = merged.get(nextParticipant.userId);
        merged.set(nextParticipant.userId, {
            userId: nextParticipant.userId,
            displayName: nextParticipant.displayName ?? existing?.displayName,
            username: nextParticipant.username ?? existing?.username,
            lastSeenAt: Math.max(nextParticipant.lastSeenAt, existing?.lastSeenAt ?? 0),
        });
    }

    return Array.from(merged.values())
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(0, MAX_SEEN_PARTICIPANTS);
}

function toAdministratorSummary(
    member: TelegramChatMemberAdministrator
): TelegramChatAdministratorMetadata | undefined {
    if (member.user.is_bot) {
        return undefined;
    }

    return {
        userId: String(member.user.id),
        displayName: getUserDisplayName(member.user),
        username: trimOrUndefined(member.user.username),
        customTitle: trimOrUndefined(member.custom_title),
    };
}

function dedupeAdministrators(
    administrators: TelegramChatAdministratorMetadata[]
): TelegramChatAdministratorMetadata[] {
    const deduped = new Map<string, TelegramChatAdministratorMetadata>();
    for (const administrator of administrators) {
        deduped.set(administrator.userId, administrator);
    }
    return Array.from(deduped.values());
}

export class TelegramChatContextService {
    private readonly store: Pick<
        TelegramChatContextStore,
        "getContext" | "listContexts" | "rememberContext"
    >;
    private readonly apiSyncTtlMs: number;
    private readonly now: () => number;

    constructor(options: TelegramChatContextServiceOptions = {}) {
        this.store = options.store ?? getTelegramChatContextStore();
        this.apiSyncTtlMs = options.apiSyncTtlMs ?? DEFAULT_API_SYNC_TTL_MS;
        this.now = options.now ?? (() => Date.now());
    }

    listContexts(): TelegramChatContextRecord[] {
        return this.store.listContexts();
    }

    async rememberChatContext(params: {
        projectId: string;
        agentPubkey: string;
        channelId: string;
        message: TelegramMessage;
        client: Pick<
            TelegramBotClient,
            "getChat" | "getChatAdministrators" | "getChatMemberCount" | "getForumTopic"
        >;
    }): Promise<TelegramChatContextRecord> {
        const now = this.now();
        const existing = this.store.getContext(
            params.projectId,
            params.agentPubkey,
            params.channelId
        );
        const seenParticipant = toSeenParticipant(params.message.from, now);

        const nextRecord: TelegramChatContextRecord = {
            projectId: params.projectId,
            agentPubkey: params.agentPubkey,
            channelId: params.channelId,
            chatId: normalizeChatId(params.message.chat.id),
            topicId: normalizeTopicId(params.message.message_thread_id),
            chatTitle: trimOrUndefined(params.message.chat.title) ?? existing?.chatTitle,
            topicTitle: existing?.topicTitle,
            chatUsername: existing?.chatUsername ?? trimOrUndefined(params.message.chat.username),
            memberCount: existing?.memberCount,
            administrators: existing?.administrators ?? [],
            seenParticipants: upsertSeenParticipants(
                existing?.seenParticipants ?? [],
                seenParticipant
            ),
            updatedAt: now,
            lastApiSyncAt: existing?.lastApiSyncAt,
        };

        const shouldRefreshApi =
            params.message.chat.type !== "private" &&
            (
                !nextRecord.lastApiSyncAt ||
                now - nextRecord.lastApiSyncAt >= this.apiSyncTtlMs
            );

        if (shouldRefreshApi) {
            nextRecord.lastApiSyncAt = now;
            const [chatResult, administratorsResult, memberCountResult] = await Promise.allSettled([
                params.client.getChat({ chatId: nextRecord.chatId }),
                params.client.getChatAdministrators({ chatId: nextRecord.chatId }),
                params.client.getChatMemberCount({ chatId: nextRecord.chatId }),
            ]);

            if (chatResult.status === "fulfilled") {
                nextRecord.chatTitle =
                    trimOrUndefined(chatResult.value.title) ?? nextRecord.chatTitle;
                nextRecord.chatUsername =
                    trimOrUndefined(chatResult.value.username) ?? nextRecord.chatUsername;
            }

            if (administratorsResult.status === "fulfilled") {
                nextRecord.administrators = dedupeAdministrators(
                    administratorsResult.value
                        .map(toAdministratorSummary)
                        .filter((entry): entry is TelegramChatAdministratorMetadata => Boolean(entry))
                );
            }

            if (memberCountResult.status === "fulfilled") {
                nextRecord.memberCount = memberCountResult.value;
            }

            if (nextRecord.topicId) {
                const topicResult = await Promise.allSettled([
                    params.client.getForumTopic({
                        chatId: nextRecord.chatId,
                        messageThreadId: nextRecord.topicId,
                    }),
                ]);

                if (topicResult[0].status === "fulfilled") {
                    nextRecord.topicTitle = trimOrUndefined(topicResult[0].value.name);
                }
            }

            if (
                chatResult.status === "rejected" ||
                administratorsResult.status === "rejected" ||
                memberCountResult.status === "rejected"
            ) {
                logger.warn("[TelegramChatContextService] Failed to fully refresh Telegram chat context", {
                    projectId: params.projectId,
                    agentPubkey: params.agentPubkey,
                    channelId: params.channelId,
                    chatLookupFailed: chatResult.status === "rejected",
                    administratorsLookupFailed: administratorsResult.status === "rejected",
                    memberCountLookupFailed: memberCountResult.status === "rejected",
                });
            }
        }

        return this.store.rememberContext(nextRecord);
    }
}
