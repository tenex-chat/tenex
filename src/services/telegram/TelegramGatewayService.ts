import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { AgentInstance } from "@/agents/types";
import type { ConfigService } from "@/services/ConfigService";
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
import {
    getTelegramChannelBindingStore,
    type TelegramChannelBindingStore,
} from "@/services/telegram/TelegramChannelBindingStoreService";
import { TelegramBindingPersistenceService } from "@/services/telegram/TelegramBindingPersistenceService";
import { TelegramChatContextService } from "@/services/telegram/TelegramChatContextService";
import {
    buildTelegramTransportMetadata,
    getTelegramUpdateContent,
    runWithTelegramUpdateSpan,
    withActiveTraceLogFields,
} from "@/telemetry/TelegramTelemetry";
import { trace } from "@opentelemetry/api";
import { logger } from "@/utils/logger";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import {
    TELEGRAM_BOT_COMMANDS,
    TELEGRAM_NEW_CONVERSATION_SUCCESS_MESSAGE,
    TelegramConfigCommandService,
} from "@/services/telegram/TelegramConfigCommandService";
import { TelegramInboundAdapter } from "@/services/telegram/TelegramInboundAdapter";
import { TelegramMediaDownloadService } from "@/services/telegram/TelegramMediaDownloadService";
import {
    hasMediaAttachment,
    isSupportedTelegramChatType,
    isProcessableTelegramMessage,
    matchesTelegramChatBinding,
    normalizeTelegramChatId,
    normalizeTelegramMessage,
    normalizeTelegramTopicId,
    runTelegramPollingLoop,
    sendUnauthorizedTelegramConfigReply,
    skipTelegramBacklog,
} from "@/services/telegram/telegram-gateway-utils";
import { createTelegramChannelId } from "@/utils/telegram-identifiers";
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
    configService: ConfigService;
    runtimeIngressService?: Pick<RuntimeIngressService, "handleChatMessage">;
    channelSessionStore?: ChannelSessionStore;
    channelBindingStore?: Pick<TelegramChannelBindingStore, "getBinding" | "rememberBinding">;
    authorizedIdentityService?: AuthorizedIdentityService;
    bindingPersistenceService?: Pick<TelegramBindingPersistenceService, "rememberProjectBinding">;
    chatContextService?: Pick<TelegramChatContextService, "rememberChatContext">;
    inboundAdapter?: Pick<TelegramInboundAdapter, "toEnvelope">;
    mediaDownloadService?: TelegramMediaDownloadService;
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

function recordTelegramOutcome(
    outcome: "dropped" | "routed",
    reason: string,
    attributes: Record<string, boolean | number | string> = {}
): void {
    const activeSpan = trace.getActiveSpan();
    activeSpan?.setAttributes({
        "telegram.update.outcome": outcome,
        "telegram.update.reason": reason,
        ...attributes,
    });
    activeSpan?.addEvent(`telegram.update.${outcome}`, {
        "telegram.update.reason": reason,
        ...attributes,
    });
}

export class TelegramGatewayService {
    private static readonly claimedBotTokens = new Set<string>();

    private readonly runtimeIngressService: Pick<RuntimeIngressService, "handleChatMessage">;
    private readonly channelSessionStore: ChannelSessionStore;
    private readonly channelBindingStore: Pick<TelegramChannelBindingStore, "getBinding" | "rememberBinding">;
    private readonly authorizedIdentityService: AuthorizedIdentityService;
    private readonly bindingPersistenceService: Pick<
        TelegramBindingPersistenceService,
        "rememberProjectBinding"
    >;
    private readonly chatContextService: Pick<TelegramChatContextService, "rememberChatContext">;
    private readonly configCommandService = new TelegramConfigCommandService();
    private readonly inboundAdapter: Pick<TelegramInboundAdapter, "toEnvelope">;
    private readonly mediaDownloadService: TelegramMediaDownloadService;
    private readonly clientFactory: (binding: TelegramGatewayBinding) => TelegramBotClient;
    private readonly pollTimeoutSeconds: number;
    private readonly pollLimit: number;
    private readonly errorBackoffMs: number;
    private readonly pollers = new Map<string, ActivePoller>();
    private running = false;

    /**
     * Project-scoped Telegram polling entrypoint for isolated tests and explicit
     * single-project runtime wiring. Shared multi-project polling uses
     * TelegramGatewayCoordinator.
     */

    constructor(private readonly options: TelegramGatewayOptions) {
        this.runtimeIngressService = options.runtimeIngressService ?? new RuntimeIngressService();
        this.channelSessionStore = options.channelSessionStore ?? getChannelSessionStore();
        this.channelBindingStore = options.channelBindingStore ?? getTelegramChannelBindingStore();
        this.authorizedIdentityService =
            options.authorizedIdentityService ?? getAuthorizedIdentityService();
        this.bindingPersistenceService =
            options.bindingPersistenceService ?? new TelegramBindingPersistenceService();
        this.chatContextService = options.chatContextService ?? new TelegramChatContextService();
        this.inboundAdapter = options.inboundAdapter ?? new TelegramInboundAdapter();
        this.mediaDownloadService =
            options.mediaDownloadService ?? new TelegramMediaDownloadService(options.configService);
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
                await this.registerBotCommands(client, binding);
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
        update: TelegramUpdate,
        botIdentity?: TelegramBotIdentity
    ): Promise<void> {
        await runWithTelegramUpdateSpan({
            update,
            source: "gateway-service",
            projectId: this.options.projectId,
            agentSlug: binding.agent.slug,
            agentPubkey: binding.agent.pubkey,
            botIdentity,
        }, async () => {
            const activeSpan = trace.getActiveSpan();
            const callbackContext = this.configCommandService.getCallbackContext(update);

            if (update.callback_query) {
                if (!callbackContext) {
                    recordTelegramOutcome("dropped", "unsupported_callback_query");
                    return;
                }

                if (
                    callbackContext.session &&
                    (
                        callbackContext.session.projectId !== this.options.projectId ||
                        callbackContext.session.agentPubkey !== binding.agent.pubkey
                    )
                ) {
                    callbackContext.session = undefined;
                }

                await this.configCommandService.handleCallback({
                    callbackContext,
                    client: this.clientFactory(binding),
                    update,
                });
                recordTelegramOutcome(
                    callbackContext.session ? "routed" : "dropped",
                    callbackContext.session ? "config_callback_handled" : "config_callback_expired"
                );
                return;
            }

            const normalizedMessage = normalizeTelegramMessage(update);
            if (!normalizedMessage?.from) {
                recordTelegramOutcome("dropped", "missing_sender");
                return;
            }

            if (normalizedMessage.from.is_bot) {
                recordTelegramOutcome("dropped", "bot_authored_update", {
                    "telegram.sender.id": String(normalizedMessage.from.id),
                });
                return;
            }

            if (!isSupportedTelegramChatType(normalizedMessage)) {
                recordTelegramOutcome("dropped", "unsupported_chat_type", {
                    "telegram.chat.type": normalizedMessage.chat.type,
                });
                return;
            }

            if (!isProcessableTelegramMessage(normalizedMessage)) {
                recordTelegramOutcome("dropped", "non_processable_message", {
                    "telegram.message.id": String(normalizedMessage.message_id),
                });
                return;
            }

            const isPrivateChat = normalizedMessage.chat.type === "private";
            const chatId = normalizeTelegramChatId(normalizedMessage.chat.id);
            const topicId = normalizeTelegramTopicId(normalizedMessage.message_thread_id);
            const channelId = createTelegramChannelId(chatId, topicId);
            const principalId = `telegram:user:${normalizedMessage.from.id}`;
            const identityBinding = getIdentityBindingStore().getBinding(principalId);
            const content = getTelegramUpdateContent(update);
            const dynamicBinding = this.channelBindingStore.getBinding(
                binding.agent.pubkey,
                channelId
            );
            const command = this.configCommandService.getCommand(
                update,
                botIdentity?.username
            );
            const commandKind = command?.type === "config" ? command.kind : undefined;
            const isNewCommand = command?.type === "new";
            const commandUsage = commandKind
                || isNewCommand
                ? this.configCommandService.getCommandUsage(update, botIdentity?.username)
                : undefined;

            logger.info("[TelegramGatewayService] Received Telegram update", withActiveTraceLogFields({
                projectId: this.options.projectId,
                agentSlug: binding.agent.slug,
                updateId: update.update_id,
                principalId,
                chatId,
                topicId,
                content,
            }));

            if (isPrivateChat) {
                if (binding.config.allowDMs === false) {
                    recordTelegramOutcome("dropped", "dm_disabled", {
                        "telegram.chat.id": chatId,
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
                    recordTelegramOutcome("dropped", "unauthorized_dm", {
                        "telegram.chat.id": chatId,
                    });
                    return;
                }
            } else {
                if (
                    commandKind &&
                    !this.authorizedIdentityService.isAuthorizedPrincipal(
                        {
                            id: principalId,
                            linkedPubkey: identityBinding?.linkedPubkey,
                        },
                        binding.config.authorizedIdentityIds
                    )
                ) {
                    await sendUnauthorizedTelegramConfigReply(
                        this.clientFactory(binding),
                        normalizedMessage
                    );
                    recordTelegramOutcome("dropped", "unauthorized_config_command");
                    return;
                }

                const matchesStaticBinding = matchesTelegramChatBinding(
                    binding.chatBindings,
                    chatId,
                    topicId
                );
                const matchesDynamicBinding = dynamicBinding?.projectId === this.options.projectId;

                if (dynamicBinding && !matchesDynamicBinding) {
                    recordTelegramOutcome("dropped", "outside_chat_binding", {
                        "telegram.chat.id": chatId,
                        "telegram.chat.thread_id": topicId ?? "",
                    });
                    return;
                }

                if (!matchesStaticBinding && !matchesDynamicBinding) {
                    if (!isNewCommand) {
                        await this.bindingPersistenceService.rememberProjectBinding({
                            projectId: this.options.projectId,
                            binding,
                            channelId,
                            message: normalizedMessage,
                            projectContext: this.options.projectContext,
                        });
                    }
                }
            }

            const projectBinding = this.options.projectContext.project.tagReference()[1];
            if (isNewCommand) {
                if (commandUsage) {
                    await this.clientFactory(binding).sendMessage({
                        chatId,
                        text: commandUsage,
                        replyToMessageId: String(normalizedMessage.message_id),
                        messageThreadId: topicId,
                    });
                    recordTelegramOutcome("routed", "new_command_usage");
                    return;
                }

                this.channelSessionStore.clearSession(
                    this.options.projectId,
                    binding.agent.pubkey,
                    channelId
                );
                await this.clientFactory(binding).sendMessage({
                    chatId,
                    text: TELEGRAM_NEW_CONVERSATION_SUCCESS_MESSAGE,
                    replyToMessageId: String(normalizedMessage.message_id),
                    messageThreadId: topicId,
                });
                recordTelegramOutcome("routed", "new_command_reset", {
                    "telegram.channel.id": channelId,
                });
                return;
            }

            if (commandKind) {
                if (commandUsage) {
                    await this.clientFactory(binding).sendMessage({
                        chatId,
                        text: commandUsage,
                        replyToMessageId: String(normalizedMessage.message_id),
                        messageThreadId: topicId,
                    });
                    recordTelegramOutcome("routed", "config_command_usage");
                    return;
                }

                await projectContextStore.run(this.options.projectContext, async () => {
                    const agent = binding.agent as AgentInstance;
                    await this.configCommandService.openCommandMenu({
                        binding,
                        client: this.clientFactory(binding),
                        commandKind,
                        currentModel: agent.llmConfig,
                        currentTools: agent.tools,
                        message: normalizedMessage,
                        principalId,
                        projectBinding,
                        projectContext: this.options.projectContext,
                        projectId: this.options.projectId,
                        projectTitle: this.options.projectContext.project.tagValue("title") ??
                            this.options.projectId,
                    });
                });
                recordTelegramOutcome("routed", "config_command_opened", {
                    "telegram.channel.id": channelId,
                });
                return;
            }

            const session = await projectContextStore.run(this.options.projectContext, async () =>
                this.channelSessionStore.getSession(
                    this.options.projectId,
                    binding.agent.pubkey,
                    channelId
                )
            );
            activeSpan?.addEvent("telegram.session_lookup", {
                "telegram.channel.id": channelId,
                "telegram.session.found": Boolean(session),
                "telegram.session.conversation_id": session?.conversationId ?? "",
            });

            let mediaInfo: { localPath: string; type: string; duration?: number; fileName?: string } | undefined;
            if (hasMediaAttachment(normalizedMessage)) {
                try {
                    const client = this.clientFactory(binding);
                    const media =
                        normalizedMessage.voice ??
                        normalizedMessage.audio ??
                        normalizedMessage.document ??
                        normalizedMessage.video ??
                        normalizedMessage.photo?.[normalizedMessage.photo.length - 1];
                    if (media) {
                        const mediaType = normalizedMessage.voice
                            ? "voice"
                            : normalizedMessage.audio
                              ? "audio"
                              : normalizedMessage.document
                                ? "document"
                                : normalizedMessage.video
                                  ? "video"
                                  : "photo";
                        const mimeType =
                            "mime_type" in media ? media.mime_type : mediaType === "photo" ? "image/jpeg" : undefined;
                        const { localPath } = await this.mediaDownloadService.download(
                            client,
                            media.file_id,
                            media.file_unique_id,
                            mimeType
                        );
                        mediaInfo = {
                            localPath,
                            type: mediaType,
                            duration: "duration" in media ? media.duration : undefined,
                            fileName: normalizedMessage.document?.file_name,
                        };
                    }
                } catch (err) {
                    logger.warn("Failed to download Telegram media attachment, forwarding without file", { err });
                }
            }

            const { envelope } = this.inboundAdapter.toEnvelope({
                update,
                binding,
                projectBinding,
                replyToNativeMessageId: session?.lastMessageId,
                botIdentity,
                mediaInfo,
                transportMetadata: await this.buildTransportMetadata({
                    binding,
                    channelId,
                    message: normalizedMessage,
                    update,
                    botIdentity,
                }),
            });
            activeSpan?.addEvent("telegram.envelope.created", {
                "runtime.message.id": envelope.message.id,
                "runtime.reply_to_id": envelope.message.replyToId ?? "",
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

                activeSpan?.setAttributes({
                    "conversation.id": conversation.id,
                });
                activeSpan?.addEvent("telegram.conversation.resolved", {
                    "conversation.id": conversation.id,
                });

                this.channelSessionStore.rememberSession({
                    projectId: this.options.projectId,
                    agentPubkey: binding.agent.pubkey,
                    channelId: envelope.channel.id,
                    conversationId: conversation.id,
                    lastMessageId: envelope.message.nativeId,
                });
                this.channelBindingStore.rememberBinding({
                    agentPubkey: binding.agent.pubkey,
                    channelId: envelope.channel.id,
                    projectId: this.options.projectId,
                });

                recordTelegramOutcome("routed", "routed_to_runtime", {
                    "conversation.id": conversation.id,
                    "telegram.channel.id": envelope.channel.id,
                });

                logger.info("[TelegramGatewayService] Routed Telegram update", withActiveTraceLogFields({
                    projectId: this.options.projectId,
                    agentSlug: binding.agent.slug,
                    updateId: update.update_id,
                    conversationId: conversation.id,
                    principalId: envelope.principal.id,
                    channelId: envelope.channel.id,
                    content: envelope.content,
                }));
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

    private async buildTransportMetadata(params: {
        binding: TelegramGatewayBinding;
        channelId: string;
        message: TelegramMessage;
        update: TelegramUpdate;
        botIdentity?: TelegramBotIdentity;
    }): Promise<ReturnType<typeof buildTelegramTransportMetadata>> {
        const chatContext = params.message.chat.type === "private"
            ? undefined
            : await this.chatContextService.rememberChatContext({
                projectId: this.options.projectId,
                agentPubkey: params.binding.agent.pubkey,
                channelId: params.channelId,
                message: params.message,
                client: this.clientFactory(params.binding),
            });

        return buildTelegramTransportMetadata(
            params.update,
            params.botIdentity,
            chatContext
                ? {
                    chatTitle: chatContext.chatTitle,
                    chatUsername: chatContext.chatUsername,
                    memberCount: chatContext.memberCount,
                    administrators: chatContext.administrators,
                    seenParticipants: chatContext.seenParticipants,
                }
                : undefined
        );
    }

    private async registerBotCommands(
        client: TelegramBotClient,
        binding: TelegramGatewayBinding
    ): Promise<void> {
        try {
            await client.setMyCommands({
                commands: TELEGRAM_BOT_COMMANDS,
            });
        } catch (error) {
            logger.warn("[TelegramGatewayService] Failed to register Telegram bot commands", {
                projectId: this.options.projectId,
                agentSlug: binding.agent.slug,
                tokenSuffix: binding.config.botToken.slice(-6),
                error: error instanceof Error ? error.message : String(error),
            });
        }
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
        const { nextOffset, skippedCount } = await skipTelegramBacklog(client, this.pollLimit);
        if (skippedCount > 0) {
            logger.info("[TelegramGatewayService] Skipped pending Telegram backlog on startup", {
                projectId: this.options.projectId,
                agentSlug: binding.agent.slug,
                skippedUpdates: skippedCount,
                nextOffset,
            });
        }
        return nextOffset;
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
        await runTelegramPollingLoop({
            shouldContinue: () => this.running,
            client: poller.client,
            getNextOffset: () => poller.nextOffset,
            setNextOffset: (offset) => {
                poller.nextOffset = offset;
            },
            assignAbortController: (abortController) => {
                poller.abortController = abortController;
            },
            releaseAbortController: (abortController) => {
                if (poller.abortController === abortController) {
                    poller.abortController = undefined;
                }
            },
            timeoutSeconds: this.pollTimeoutSeconds,
            pollLimit: this.pollLimit,
            errorBackoffMs: this.errorBackoffMs,
            processUpdate: async (update) => {
                await this.processUpdate(poller.binding, update, poller.botIdentity);
            },
            onProcessUpdateError: (update, error) => {
                logger.warn("[TelegramGatewayService] Failed to process Telegram update", {
                    projectId: this.options.projectId,
                    agentSlug: poller.binding.agent.slug,
                    updateId: update.update_id,
                    error: error instanceof Error ? error.message : String(error),
                });
            },
            onLoopError: (error) => {
                logger.warn("[TelegramGatewayService] Telegram poll loop error", {
                    projectId: this.options.projectId,
                    agentSlug: poller.binding.agent.slug,
                    error: error instanceof Error ? error.message : String(error),
                });
            },
        });
    }
}
