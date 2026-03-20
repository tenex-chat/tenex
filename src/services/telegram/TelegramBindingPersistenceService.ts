import { AgentStorage } from "@/agents/AgentStorage";
import type { TelegramChatBinding } from "@/events/runtime/RuntimeAgent";
import type { ProjectContext } from "@/services/projects";
import {
    TelegramChannelBindingStore,
    getTelegramChannelBindingStore,
} from "@/services/telegram/TelegramChannelBindingStoreService";
import type {
    TelegramGatewayBinding,
    TelegramMessage,
} from "@/services/telegram/types";
import { logger } from "@/utils/logger";

interface TelegramBindingPersistenceServiceOptions {
    agentStorage?: Pick<AgentStorage, "getEffectiveConfig" | "loadAgent" | "updateProjectTelegramConfig">;
    channelBindingStore?: Pick<TelegramChannelBindingStore, "rememberBinding">;
}

function normalizeChatId(chatId: string | number): string {
    return String(chatId);
}

function normalizeTopicId(topicId: string | number | undefined): string | undefined {
    return topicId === undefined ? undefined : String(topicId);
}

function getChatBindingKey(binding: Pick<TelegramChatBinding, "chatId" | "topicId">): string {
    return `${binding.chatId}::${binding.topicId ?? ""}`;
}

function buildTelegramChatBinding(message: TelegramMessage): TelegramChatBinding {
    return {
        chatId: normalizeChatId(message.chat.id),
        topicId: normalizeTopicId(message.message_thread_id),
        title: message.chat.title?.trim() || undefined,
    };
}

function upsertTelegramChatBindings(
    existingBindings: TelegramChatBinding[],
    nextBinding: TelegramChatBinding
): TelegramChatBinding[] {
    const nextKey = getChatBindingKey(nextBinding);
    const deduplicated: TelegramChatBinding[] = [];
    let replaced = false;

    for (const binding of existingBindings) {
        const currentKey = getChatBindingKey(binding);
        if (currentKey !== nextKey) {
            deduplicated.push(binding);
            continue;
        }

        if (replaced) {
            continue;
        }

        deduplicated.push({
            ...binding,
            title: binding.title ?? nextBinding.title,
        });
        replaced = true;
    }

    if (!replaced) {
        deduplicated.push(nextBinding);
    }

    return deduplicated;
}

export class TelegramBindingPersistenceService {
    private readonly agentStorage: Pick<
        AgentStorage,
        "getEffectiveConfig" | "loadAgent" | "updateProjectTelegramConfig"
    >;
    private readonly channelBindingStore: Pick<TelegramChannelBindingStore, "rememberBinding">;

    constructor(options: TelegramBindingPersistenceServiceOptions = {}) {
        this.agentStorage = options.agentStorage ?? new AgentStorage();
        this.channelBindingStore = options.channelBindingStore ?? getTelegramChannelBindingStore();
    }

    async rememberProjectBinding(params: {
        projectId: string;
        binding: TelegramGatewayBinding;
        channelId: string;
        message: TelegramMessage;
        projectContext?: Pick<ProjectContext, "agentRegistry" | "getAgentByPubkey">;
    }): Promise<TelegramGatewayBinding> {
        this.channelBindingStore.rememberBinding({
            agentPubkey: params.binding.agent.pubkey,
            channelId: params.channelId,
            projectId: params.projectId,
        });

        if (params.message.chat.type === "private") {
            return params.binding;
        }

        const nextChatBinding = buildTelegramChatBinding(params.message);
        const immediateChatBindings = upsertTelegramChatBindings(
            params.binding.chatBindings ?? [],
            nextChatBinding
        );

        params.binding.chatBindings = immediateChatBindings;
        params.binding.config = {
            ...params.binding.config,
            chatBindings: immediateChatBindings,
        };

        try {
            const storedAgent = await this.agentStorage.loadAgent(params.binding.agent.pubkey);
            if (!storedAgent) {
                logger.warn("[TelegramBindingPersistenceService] Stored agent not found while persisting Telegram binding", {
                    projectId: params.projectId,
                    agentPubkey: params.binding.agent.pubkey,
                    channelId: params.channelId,
                });
                return params.binding;
            }

            const effectiveTelegram =
                this.agentStorage.getEffectiveConfig(storedAgent, params.projectId).telegram ??
                params.binding.config;
            const nextTelegramConfig = {
                ...effectiveTelegram,
                chatBindings: upsertTelegramChatBindings(
                    effectiveTelegram?.chatBindings ?? [],
                    nextChatBinding
                ),
            };

            const updated = await this.agentStorage.updateProjectTelegramConfig(
                params.binding.agent.pubkey,
                params.projectId,
                nextTelegramConfig
            );
            if (!updated) {
                logger.warn("[TelegramBindingPersistenceService] Failed to update project Telegram config", {
                    projectId: params.projectId,
                    agentPubkey: params.binding.agent.pubkey,
                    channelId: params.channelId,
                });
                return params.binding;
            }

            if (!params.projectContext) {
                return params.binding;
            }

            const reloaded = await params.projectContext.agentRegistry.reloadAgent(
                params.binding.agent.pubkey
            );
            if (!reloaded) {
                logger.warn("[TelegramBindingPersistenceService] Failed to reload agent after Telegram binding update", {
                    projectId: params.projectId,
                    agentPubkey: params.binding.agent.pubkey,
                    channelId: params.channelId,
                });
                return params.binding;
            }

            const refreshedAgent = params.projectContext.getAgentByPubkey(
                params.binding.agent.pubkey
            );
            if (!refreshedAgent?.telegram) {
                return params.binding;
            }

            params.binding.agent = refreshedAgent;
            params.binding.config = refreshedAgent.telegram;
            params.binding.chatBindings = refreshedAgent.telegram.chatBindings ?? [];
        } catch (error) {
            logger.warn("[TelegramBindingPersistenceService] Failed to persist Telegram chat binding", {
                projectId: params.projectId,
                agentPubkey: params.binding.agent.pubkey,
                channelId: params.channelId,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        return params.binding;
    }
}

export { buildTelegramChatBinding, upsertTelegramChatBindings };
