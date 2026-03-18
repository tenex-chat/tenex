import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { RuntimeIngressService } from "@/services/ingress/RuntimeIngressService";
import {
    getChannelSessionStore,
    type ChannelSessionStore,
} from "@/services/ingress/ChannelSessionStoreService";
import {
    getAuthorizedIdentityService,
    getIdentityBindingStore,
    type AuthorizedIdentityService,
} from "@/services/identity";
import { projectContextStore, type ProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import { TelegramInboundAdapter } from "@/services/telegram/TelegramInboundAdapter";
import { createTelegramChannelId } from "@/services/telegram/telegram-identifiers";
import type {
    TelegramBotIdentity,
    TelegramGatewayBinding,
    TelegramMessage,
    TelegramUpdate,
} from "@/services/telegram/types";

interface TelegramGatewayOptions {
    projectId: string;
    projectContext: ProjectContext;
    agentExecutor: AgentExecutor;
    runtimeIngressService?: Pick<RuntimeIngressService, "handleChatMessage">;
    channelSessionStore?: ChannelSessionStore;
    authorizedIdentityService?: AuthorizedIdentityService;
    inboundAdapter?: Pick<TelegramInboundAdapter, "toEnvelope">;
    clientFactory?: (binding: TelegramGatewayBinding) => TelegramBotClient;
    pollTimeoutSeconds?: number;
    pollLimit?: number;
    errorBackoffMs?: number;
}

interface ActivePoller {
    binding: TelegramGatewayBinding;
    botIdentity: TelegramBotIdentity;
    client: TelegramBotClient;
    nextOffset?: number;
    abortController?: AbortController;
    loopPromise: Promise<void>;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeChatId(chatId: string | number): string {
    return String(chatId);
}

function normalizeTopicId(topicId: string | number | undefined): string | undefined {
    return topicId === undefined ? undefined : String(topicId);
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function isTextualMessage(message: TelegramMessage): boolean {
    return Boolean(message.text?.trim() || message.caption?.trim());
}

function isSupportedChatType(message: TelegramMessage): boolean {
    return message.chat.type === "private" ||
        message.chat.type === "group" ||
        message.chat.type === "supergroup";
}

function matchesChatBinding(
    binding: TelegramGatewayBinding,
    chatId: string,
    topicId?: string
): boolean {
    if ((binding.chatBindings?.length ?? 0) === 0) {
        return true;
    }

    return binding.chatBindings.some((chatBinding) => {
        if (chatBinding.chatId !== chatId) {
            return false;
        }

        if (!chatBinding.topicId) {
            return true;
        }

        return chatBinding.topicId === topicId;
    });
}

export class TelegramGatewayService {
    private static readonly claimedBotTokens = new Set<string>();

    private readonly runtimeIngressService: Pick<RuntimeIngressService, "handleChatMessage">;
    private readonly channelSessionStore: ChannelSessionStore;
    private readonly authorizedIdentityService: AuthorizedIdentityService;
    private readonly inboundAdapter: Pick<TelegramInboundAdapter, "toEnvelope">;
    private readonly clientFactory: (binding: TelegramGatewayBinding) => TelegramBotClient;
    private readonly pollTimeoutSeconds: number;
    private readonly pollLimit: number;
    private readonly errorBackoffMs: number;
    private readonly pollers = new Map<string, ActivePoller>();
    private running = false;

    constructor(private readonly options: TelegramGatewayOptions) {
        this.runtimeIngressService = options.runtimeIngressService ?? new RuntimeIngressService();
        this.channelSessionStore = options.channelSessionStore ?? getChannelSessionStore();
        this.authorizedIdentityService =
            options.authorizedIdentityService ?? getAuthorizedIdentityService();
        this.inboundAdapter = options.inboundAdapter ?? new TelegramInboundAdapter();
        this.clientFactory = options.clientFactory ?? ((binding) =>
            new TelegramBotClient({
                botToken: binding.config.botToken,
                apiBaseUrl: binding.config.apiBaseUrl,
            }));
        this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 20;
        this.pollLimit = options.pollLimit ?? 50;
        this.errorBackoffMs = options.errorBackoffMs ?? 1500;
    }

    static resetClaims(): void {
        TelegramGatewayService.claimedBotTokens.clear();
    }

    async start(): Promise<void> {
        if (this.running) {
            logger.warn("[TelegramGatewayService] Already started", {
                projectId: this.options.projectId,
            });
            return;
        }

        const bindings = this.getBindings();
        if (bindings.length === 0) {
            logger.debug("[TelegramGatewayService] No Telegram-enabled agents for project", {
                projectId: this.options.projectId,
            });
            return;
        }

        this.assertUniqueBotTokens(bindings);
        this.running = true;
        const claimedTokens: string[] = [];

        try {
            for (const binding of bindings) {
                TelegramGatewayService.claimedBotTokens.add(binding.config.botToken);
                claimedTokens.push(binding.config.botToken);
                const client = this.clientFactory(binding);
                const botIdentity = await client.getMe();
                const nextOffset = await this.skipBacklog(client, binding);
                const poller = this.createPoller(binding, botIdentity, client, nextOffset);
                this.pollers.set(binding.config.botToken, poller);
            }

            logger.info("[TelegramGatewayService] Started Telegram pollers", {
                projectId: this.options.projectId,
                pollerCount: this.pollers.size,
                agentSlugs: bindings.map((binding) => binding.agent.slug),
            });
        } catch (error) {
            for (const token of claimedTokens) {
                TelegramGatewayService.claimedBotTokens.delete(token);
            }
            await this.stop();
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.running = false;

        for (const poller of this.pollers.values()) {
            poller.abortController?.abort();
        }

        const activePollers = Array.from(this.pollers.values());
        this.pollers.clear();

        await Promise.allSettled(activePollers.map((poller) => poller.loopPromise));

        for (const poller of activePollers) {
            TelegramGatewayService.claimedBotTokens.delete(poller.binding.config.botToken);
        }
    }

    async processUpdate(
        binding: TelegramGatewayBinding,
        update: TelegramUpdate
    ): Promise<void> {
        const normalizedMessage = update.message ?? update.edited_message;
        if (!normalizedMessage?.from) {
            logger.debug("[TelegramGatewayService] Ignoring update without sender", {
                projectId: this.options.projectId,
                agentSlug: binding.agent.slug,
                updateId: update.update_id,
            });
            return;
        }

        if (normalizedMessage.from.is_bot) {
            logger.debug("[TelegramGatewayService] Ignoring bot-authored update", {
                projectId: this.options.projectId,
                agentSlug: binding.agent.slug,
                updateId: update.update_id,
                fromId: normalizedMessage.from.id,
            });
            return;
        }

        if (!isSupportedChatType(normalizedMessage)) {
            logger.debug("[TelegramGatewayService] Ignoring unsupported chat type", {
                projectId: this.options.projectId,
                agentSlug: binding.agent.slug,
                updateId: update.update_id,
                chatType: normalizedMessage.chat.type,
            });
            return;
        }

        if (!isTextualMessage(normalizedMessage)) {
            logger.debug("[TelegramGatewayService] Ignoring non-text Telegram update", {
                projectId: this.options.projectId,
                agentSlug: binding.agent.slug,
                updateId: update.update_id,
                chatId: normalizedMessage.chat.id,
            });
            return;
        }

        const isPrivateChat = normalizedMessage.chat.type === "private";
        const chatId = normalizeChatId(normalizedMessage.chat.id);
        const topicId = normalizeTopicId(normalizedMessage.message_thread_id);

        const principalId = `telegram:user:${normalizedMessage.from.id}`;
        const identityBinding = getIdentityBindingStore().getBinding(principalId);
        if (isPrivateChat) {
            if (binding.config.allowDMs === false) {
                logger.info("[TelegramGatewayService] Ignoring Telegram DM because DMs are disabled", {
                    projectId: this.options.projectId,
                    agentSlug: binding.agent.slug,
                    updateId: update.update_id,
                    principalId,
                });
                return;
            }

            const isAuthorized = this.authorizedIdentityService.isAuthorizedPrincipal(
                {
                    id: principalId,
                    linkedPubkey: identityBinding?.linkedPubkey,
                },
                binding.config.authorizedIdentityIds
            );

            if (!isAuthorized) {
                logger.info("[TelegramGatewayService] Ignoring unauthorized Telegram DM", {
                    projectId: this.options.projectId,
                    agentSlug: binding.agent.slug,
                    updateId: update.update_id,
                    principalId,
                });
                return;
            }
        } else if (!matchesChatBinding(binding, chatId, topicId)) {
            logger.debug("[TelegramGatewayService] Ignoring Telegram group update outside bindings", {
                projectId: this.options.projectId,
                agentSlug: binding.agent.slug,
                updateId: update.update_id,
                chatId,
                topicId,
            });
            return;
        }

        const projectBinding = this.options.projectContext.project.tagReference()[1];
        const session = await projectContextStore.run(this.options.projectContext, async () =>
            this.channelSessionStore.getSession(
                this.options.projectId,
                binding.agent.pubkey,
                createTelegramChannelId(chatId, normalizedMessage.message_thread_id)
            )
        );

        const { envelope } = this.inboundAdapter.toEnvelope({
            update,
            binding,
            projectBinding,
            replyToNativeMessageId: session?.lastMessageId,
        });

        await projectContextStore.run(this.options.projectContext, async () => {
            if (session?.conversationId) {
                ConversationStore.getOrLoad(session.conversationId);
            }

            await this.runtimeIngressService.handleChatMessage({
                envelope,
                agentExecutor: this.options.agentExecutor,
                adapter: this.inboundAdapter.constructor.name,
            });

            const conversation = ConversationStore.findByEventId(envelope.message.nativeId);
            if (!conversation) {
                throw new Error(
                    `Telegram update ${update.update_id} did not resolve a conversation`
                );
            }

            this.channelSessionStore.rememberSession({
                projectId: this.options.projectId,
                agentPubkey: binding.agent.pubkey,
                channelId: envelope.channel.id,
                conversationId: conversation.id,
                lastMessageId: envelope.message.nativeId,
            });

            logger.info("[TelegramGatewayService] Routed Telegram update", {
                projectId: this.options.projectId,
                agentSlug: binding.agent.slug,
                updateId: update.update_id,
                conversationId: conversation.id,
                principalId: envelope.principal.id,
                channelId: envelope.channel.id,
            });
        });
    }

    private getBindings(): TelegramGatewayBinding[] {
        return Array.from(this.options.projectContext.agents.values())
            .filter((agent): agent is AgentInstance & { telegram: NonNullable<AgentInstance["telegram"]> } =>
                Boolean(agent.telegram?.botToken)
            )
            .map((agent) => ({
                agent,
                config: agent.telegram,
                chatBindings: agent.telegram?.chatBindings ?? [],
            }));
    }

    private assertUniqueBotTokens(bindings: TelegramGatewayBinding[]): void {
        const tokenOwners = new Map<string, string>();

        for (const binding of bindings) {
            const existingOwner = tokenOwners.get(binding.config.botToken);
            if (existingOwner) {
                throw new Error(
                    `Telegram bot token is configured for multiple agents in project ${this.options.projectId}: ${existingOwner}, ${binding.agent.slug}`
                );
            }

            if (TelegramGatewayService.claimedBotTokens.has(binding.config.botToken)) {
                throw new Error(
                    `Telegram bot token for agent ${binding.agent.slug} is already in use by another active runtime`
                );
            }

            tokenOwners.set(binding.config.botToken, binding.agent.slug);
        }
    }

    private async skipBacklog(
        client: TelegramBotClient,
        binding: TelegramGatewayBinding
    ): Promise<number | undefined> {
        let offset: number | undefined;
        let skipped = 0;

        while (true) {
            const updates = await client.getUpdates({
                offset,
                timeoutSeconds: 0,
                limit: this.pollLimit,
            });

            if (updates.length === 0) {
                if (skipped > 0) {
                    logger.info("[TelegramGatewayService] Skipped pending Telegram backlog on startup", {
                        projectId: this.options.projectId,
                        agentSlug: binding.agent.slug,
                        skippedUpdates: skipped,
                        nextOffset: offset,
                    });
                }
                return offset;
            }

            skipped += updates.length;
            const lastUpdate = updates[updates.length - 1];
            offset = lastUpdate ? lastUpdate.update_id + 1 : offset;
        }
    }

    private createPoller(
        binding: TelegramGatewayBinding,
        botIdentity: TelegramBotIdentity,
        client: TelegramBotClient,
        nextOffset?: number
    ): ActivePoller {
        const poller: ActivePoller = {
            binding,
            botIdentity,
            client,
            nextOffset,
            loopPromise: Promise.resolve(),
        };

        poller.loopPromise = this.runPollLoop(poller);
        return poller;
    }

    private async runPollLoop(poller: ActivePoller): Promise<void> {
        while (this.running) {
            const abortController = new AbortController();
            poller.abortController = abortController;

            try {
                const updates = await poller.client.getUpdates({
                    offset: poller.nextOffset,
                    timeoutSeconds: this.pollTimeoutSeconds,
                    limit: this.pollLimit,
                    signal: abortController.signal,
                });

                for (const update of updates) {
                    if (!this.running) {
                        break;
                    }

                    try {
                        await this.processUpdate(poller.binding, update);
                    } catch (error) {
                        logger.warn("[TelegramGatewayService] Failed to process Telegram update", {
                            projectId: this.options.projectId,
                            agentSlug: poller.binding.agent.slug,
                            updateId: update.update_id,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    } finally {
                        poller.nextOffset = update.update_id + 1;
                    }
                }
            } catch (error) {
                if (!this.running || isAbortError(error)) {
                    break;
                }

                logger.warn("[TelegramGatewayService] Telegram poll loop error", {
                    projectId: this.options.projectId,
                    agentSlug: poller.binding.agent.slug,
                    error: error instanceof Error ? error.message : String(error),
                });
                await sleep(this.errorBackoffMs);
            } finally {
                if (poller.abortController === abortController) {
                    poller.abortController = undefined;
                }
            }
        }
    }
}
