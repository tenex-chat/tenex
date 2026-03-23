import type { AgentInstance } from "@/agents/types";
import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
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
import type {
    TelegramBotIdentity,
    TelegramGatewayBinding,
    TelegramMessage,
    TelegramUpdate,
} from "@/services/telegram/types";
import { projectContextStore } from "@/services/projects";
import { TelegramBindingPersistenceService } from "@/services/telegram/TelegramBindingPersistenceService";
import { TelegramChatContextService } from "@/services/telegram/TelegramChatContextService";
import { getTelegramChannelBindingStore } from "@/services/telegram/TelegramChannelBindingStoreService";
import { getTelegramPendingBindingStore } from "@/services/telegram/TelegramPendingBindingStoreService";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import {
    TELEGRAM_CONFIG_BOT_COMMANDS,
    TelegramConfigCommandService,
} from "@/services/telegram/TelegramConfigCommandService";
import { TelegramInboundAdapter } from "@/services/telegram/TelegramInboundAdapter";
import {
    isSupportedTelegramChatType,
    isTextualTelegramMessage,
    matchesTelegramChatBinding,
    normalizeTelegramChatId,
    normalizeTelegramMessage,
    normalizeTelegramTopicId,
    runTelegramPollingLoop,
    sendUnauthorizedTelegramConfigReply,
    skipTelegramBacklog,
} from "@/services/telegram/telegram-gateway-utils";
import { createTelegramChannelId } from "@/utils/telegram-identifiers";
import {
    buildTelegramTransportMetadata,
    getTelegramUpdateContent,
    runWithTelegramUpdateSpan,
    withActiveTraceLogFields,
} from "@/telemetry/TelegramTelemetry";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";

interface TelegramRuntimeRegistration {
    projectId: string;
    projectTitle: string;
    projectBinding: string;
    runInProjectContext<T>(operation: () => Promise<T>): Promise<T>;
    agentExecutor: AgentExecutor;
    binding: TelegramGatewayBinding;
}

interface TelegramPollerState {
    token: string;
    agentPubkey: string;
    client: TelegramBotClient;
    botIdentity: TelegramBotIdentity;
    nextOffset?: number;
    abortController?: AbortController;
    loopPromise: Promise<void>;
}

function deduplicateRegistrations(
    registrations: TelegramRuntimeRegistration[]
): TelegramRuntimeRegistration[] {
    const seen = new Set<string>();
    const result: TelegramRuntimeRegistration[] = [];

    for (const registration of registrations) {
        const key = `${registration.projectId}::${registration.binding.agent.pubkey}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(registration);
    }

    return result;
}

function parseProjectSelection(
    input: string,
    registrations: TelegramRuntimeRegistration[]
): TelegramRuntimeRegistration | undefined {
    const trimmed = input.trim();
    if (!trimmed) {
        return undefined;
    }

    const numericSelection = Number(trimmed);
    if (Number.isInteger(numericSelection) && numericSelection >= 1 && numericSelection <= registrations.length) {
        return registrations[numericSelection - 1];
    }

    const normalized = trimmed.toLowerCase();
    return registrations.find((registration) =>
        registration.projectId.toLowerCase() === normalized ||
        registration.projectTitle.toLowerCase() === normalized
    );
}

function recordTelegramOutcome(
    outcome: "dropped" | "pending-binding" | "routed",
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

export class TelegramGatewayCoordinator {
    private static instance: TelegramGatewayCoordinator;

    private readonly registrations = new Map<string, TelegramRuntimeRegistration[]>();
    private readonly pollers = new Map<string, TelegramPollerState>();
    private readonly runtimeIngressService = new RuntimeIngressService();
    private readonly inboundAdapter = new TelegramInboundAdapter();
    private readonly channelSessionStore: ChannelSessionStore = getChannelSessionStore();
    private readonly channelBindingStore = getTelegramChannelBindingStore();
    private readonly pendingBindingStore = getTelegramPendingBindingStore();
    private readonly bindingPersistenceService = new TelegramBindingPersistenceService();
    private readonly chatContextService = new TelegramChatContextService();
    private readonly configCommandService = new TelegramConfigCommandService();
    private readonly authorizedIdentityService: AuthorizedIdentityService =
        getAuthorizedIdentityService();
    private readonly pollTimeoutSeconds = 20;
    private readonly pollLimit = 50;
    private readonly errorBackoffMs = 1500;

    static getInstance(): TelegramGatewayCoordinator {
        if (!TelegramGatewayCoordinator.instance) {
            TelegramGatewayCoordinator.instance = new TelegramGatewayCoordinator();
        }
        return TelegramGatewayCoordinator.instance;
    }

    static resetInstance(): void {
        TelegramGatewayCoordinator.instance = undefined as unknown as TelegramGatewayCoordinator;
    }

    async registerRuntime(params: {
        projectId: string;
        projectTitle: string;
        projectBinding: string;
        agents: Iterable<TelegramGatewayBinding["agent"]>;
        runInProjectContext<T>(operation: () => Promise<T>): Promise<T>;
        agentExecutor: AgentExecutor;
    }): Promise<void> {
        const {
            projectId,
            projectTitle,
            projectBinding,
            agents,
            runInProjectContext,
            agentExecutor,
        } = params;
        const groupedBindings = new Map<string, TelegramRuntimeRegistration[]>();

        for (const agent of agents) {
            if (!agent.telegram?.botToken) {
                continue;
            }

            const registration: TelegramRuntimeRegistration = {
                projectId,
                projectTitle,
                projectBinding,
                runInProjectContext,
                agentExecutor,
                binding: {
                    agent,
                    config: agent.telegram,
                    chatBindings: agent.telegram.chatBindings ?? [],
                },
            };

            const existing = groupedBindings.get(agent.telegram.botToken) ?? [];
            existing.push(registration);
            groupedBindings.set(agent.telegram.botToken, existing);
        }

        for (const [token, newRegistrations] of groupedBindings.entries()) {
            const existing = this.registrations.get(token) ?? [];
            const distinctAgentPubkeys = new Set(
                [...existing, ...newRegistrations].map((registration) => registration.binding.agent.pubkey)
            );
            if (distinctAgentPubkeys.size > 1) {
                throw new Error(
                    `Telegram bot token is assigned to multiple agent identities: ${Array.from(distinctAgentPubkeys).join(", ")}`
                );
            }

            const filteredExisting = existing.filter((registration) => registration.projectId !== projectId);
            const merged = deduplicateRegistrations([...filteredExisting, ...newRegistrations]);
            this.registrations.set(token, merged);

            const firstRegistration = merged[0];
            if (!this.pollers.has(token) && firstRegistration) {
                await this.startPoller(token, firstRegistration);
            }
        }
    }

    async unregisterRuntime(projectId: string): Promise<void> {
        const pollersToStop: TelegramPollerState[] = [];

        for (const [token, registrations] of this.registrations.entries()) {
            const remaining = registrations.filter((registration) => registration.projectId !== projectId);
            if (remaining.length === 0) {
                this.registrations.delete(token);
                const poller = this.pollers.get(token);
                if (poller) {
                    this.pollers.delete(token);
                    pollersToStop.push(poller);
                }
            } else {
                this.registrations.set(token, remaining);
            }
        }

        for (const poller of pollersToStop) {
            poller.abortController?.abort();
            await poller.loopPromise.catch(() => undefined);
        }
    }

    private async startPoller(
        token: string,
        registration: TelegramRuntimeRegistration
    ): Promise<void> {
        const client = new TelegramBotClient({
            botToken: token,
            apiBaseUrl: registration.binding.config.apiBaseUrl,
        });
        const botIdentity = await client.getMe();
        await this.registerBotCommands(client, registration);
        const nextOffset = await this.skipBacklog(client);
        const poller: TelegramPollerState = {
            token,
            agentPubkey: registration.binding.agent.pubkey,
            client,
            botIdentity,
            nextOffset,
            loopPromise: Promise.resolve(),
        };
        this.pollers.set(token, poller);
        poller.loopPromise = this.runPollLoop(poller);

        logger.info("[TelegramGatewayCoordinator] Started Telegram poller", {
            tokenSuffix: token.slice(-6),
            agentSlug: registration.binding.agent.slug,
            projectCount: this.registrations.get(token)?.length ?? 0,
        });
    }

    private async registerBotCommands(
        client: TelegramBotClient,
        registration: TelegramRuntimeRegistration
    ): Promise<void> {
        try {
            await client.setMyCommands({
                commands: TELEGRAM_CONFIG_BOT_COMMANDS,
            });
        } catch (error) {
            logger.warn("[TelegramGatewayCoordinator] Failed to register Telegram bot commands", {
                tokenSuffix: registration.binding.config.botToken.slice(-6),
                agentSlug: registration.binding.agent.slug,
                projectId: registration.projectId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async skipBacklog(client: TelegramBotClient): Promise<number | undefined> {
        return (await skipTelegramBacklog(client, this.pollLimit)).nextOffset;
    }

    private async runPollLoop(poller: TelegramPollerState): Promise<void> {
        await runTelegramPollingLoop({
            shouldContinue: () => this.pollers.has(poller.token),
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
                await this.processUpdate(poller, update);
            },
            onProcessUpdateError: (update, error) => {
                logger.warn("[TelegramGatewayCoordinator] Failed to process update", {
                    tokenSuffix: poller.token.slice(-6),
                    updateId: update.update_id,
                    error: error instanceof Error ? error.message : String(error),
                });
            },
            onLoopError: (error) => {
                logger.warn("[TelegramGatewayCoordinator] Poll loop error", {
                    tokenSuffix: poller.token.slice(-6),
                    error: error instanceof Error ? error.message : String(error),
                });
            },
        });
    }

    private async processUpdate(poller: TelegramPollerState, update: TelegramUpdate): Promise<void> {
        const registrations = deduplicateRegistrations(this.registrations.get(poller.token) ?? []);
        const primaryRegistration = registrations[0];

        await runWithTelegramUpdateSpan({
            update,
            source: "gateway-coordinator",
            projectId: registrations.length === 1 ? primaryRegistration?.projectId : undefined,
            projectTitle: registrations.length === 1 ? primaryRegistration?.projectTitle : undefined,
            agentSlug: primaryRegistration?.binding.agent.slug,
            agentPubkey: primaryRegistration?.binding.agent.pubkey ?? poller.agentPubkey,
            botIdentity: poller.botIdentity,
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
                    !registrations.some((registration) =>
                        registration.projectId === callbackContext.session?.projectId &&
                        registration.binding.agent.pubkey === callbackContext.session?.agentPubkey
                    )
                ) {
                    callbackContext.session = undefined;
                }

                await this.configCommandService.handleCallback({
                    callbackContext,
                    client: poller.client,
                    update,
                });
                recordTelegramOutcome(
                    callbackContext.session ? "routed" : "dropped",
                    callbackContext.session ? "config_callback_handled" : "config_callback_expired"
                );
                return;
            }

            const message = normalizeTelegramMessage(update);

            activeSpan?.addEvent("telegram.registrations_resolved", {
                "telegram.registration.count": registrations.length,
            });

            if (registrations.length === 0) {
                recordTelegramOutcome("dropped", "no_registrations");
                return;
            }

            if (!message?.from) {
                recordTelegramOutcome("dropped", "missing_sender");
                return;
            }

            if (message.from.is_bot) {
                recordTelegramOutcome("dropped", "bot_authored_update", {
                    "telegram.sender.id": String(message.from.id),
                });
                return;
            }

            if (!isSupportedTelegramChatType(message)) {
                recordTelegramOutcome("dropped", "unsupported_chat_type", {
                    "telegram.chat.type": message.chat.type,
                });
                return;
            }

            if (!isTextualTelegramMessage(message)) {
                recordTelegramOutcome("dropped", "non_text_message", {
                    "telegram.message.id": String(message.message_id),
                });
                return;
            }

            if (!primaryRegistration) {
                recordTelegramOutcome("dropped", "missing_primary_registration");
                return;
            }

            const chatId = normalizeTelegramChatId(message.chat.id);
            const topicId = normalizeTelegramTopicId(message.message_thread_id);
            const channelId = createTelegramChannelId(chatId, topicId);
            const agentPubkey = primaryRegistration.binding.agent.pubkey;
            const principalId = `telegram:user:${message.from.id}`;
            const identityBinding = getIdentityBindingStore().getBinding(principalId);
            const pending = this.pendingBindingStore.getPending(agentPubkey, channelId);
            const content = getTelegramUpdateContent(update);
            const commandKind = this.configCommandService.getCommandKind(
                update,
                poller.botIdentity.username
            );
            const commandUsage = commandKind
                ? this.configCommandService.getCommandUsage(update, poller.botIdentity.username)
                : undefined;

            logger.info("[TelegramGatewayCoordinator] Received Telegram update", withActiveTraceLogFields({
                updateId: update.update_id,
                agentSlug: primaryRegistration.binding.agent.slug,
                agentPubkey,
                chatId,
                topicId,
                principalId,
                registrationCount: registrations.length,
                content,
            }));

            if (pending) {
                activeSpan?.addEvent("telegram.project_binding.pending_found", {
                    "telegram.channel.id": channelId,
                    "telegram.pending.project_count": pending.projects.length,
                });
                const selected = parseProjectSelection(content, registrations
                    .filter((registration) => pending.projects.some((project) => project.projectId === registration.projectId)));
                if (!selected) {
                    recordTelegramOutcome("pending-binding", "project_selection_reminder", {
                        "telegram.pending.project_count": pending.projects.length,
                    });
                    await this.sendProjectSelectionPrompt(poller, registrations, message, true);
                    return;
                }

                activeSpan?.setAttributes({
                    "project.id": selected.projectId,
                    "project.title": selected.projectTitle,
                });

                await this.bindChannelToRegistration(selected, channelId, message);
                this.pendingBindingStore.clearPending(agentPubkey, channelId);

                await poller.client.sendMessage({
                    chatId,
                    text: `Bound this chat to project "${selected.projectTitle}". Send your next message to continue.`,
                    replyToMessageId: String(message.message_id),
                    messageThreadId: topicId,
                });
                recordTelegramOutcome("routed", "project_bound_via_reply", {
                    "project.id": selected.projectId,
                    "telegram.channel.id": channelId,
                });
                return;
            }

            const session = this.channelSessionStore.findSessionByAgentChannel(agentPubkey, channelId);
            activeSpan?.addEvent("telegram.session_lookup", {
                "telegram.channel.id": channelId,
                "telegram.session.found": Boolean(session),
                "telegram.session.conversation_id": session?.conversationId ?? "",
                "project.id": session?.projectId ?? "",
            });
            if (session) {
                const selected = registrations.find((registration) => registration.projectId === session.projectId);
                if (selected) {
                    if (
                        commandKind &&
                        !this.isAuthorizedConfigPrincipal(principalId, identityBinding?.linkedPubkey, selected)
                    ) {
                        await sendUnauthorizedTelegramConfigReply(poller.client, message);
                        recordTelegramOutcome("dropped", "unauthorized_config_command");
                        return;
                    }

                    activeSpan?.setAttributes({
                        "project.id": selected.projectId,
                        "project.title": selected.projectTitle,
                    });
                    await this.handleSelectedRegistration({
                        botIdentity: poller.botIdentity,
                        channelId,
                        client: poller.client,
                        commandKind,
                        commandUsage,
                        message,
                        principalId,
                        registration: selected,
                        update,
                    });
                    return;
                }
            }

            const dynamicBinding = this.channelBindingStore.getBinding(agentPubkey, channelId);
            activeSpan?.addEvent("telegram.channel_binding_lookup", {
                "telegram.channel.id": channelId,
                "telegram.binding.found": Boolean(dynamicBinding),
                "project.id": dynamicBinding?.projectId ?? "",
            });
            if (dynamicBinding) {
                const selected = registrations.find(
                    (registration) => registration.projectId === dynamicBinding.projectId
                );
                if (selected) {
                    if (
                        commandKind &&
                        !this.isAuthorizedConfigPrincipal(principalId, identityBinding?.linkedPubkey, selected)
                    ) {
                        await sendUnauthorizedTelegramConfigReply(poller.client, message);
                        recordTelegramOutcome("dropped", "unauthorized_config_command");
                        return;
                    }

                    activeSpan?.setAttributes({
                        "project.id": selected.projectId,
                        "project.title": selected.projectTitle,
                    });
                    await this.handleSelectedRegistration({
                        botIdentity: poller.botIdentity,
                        channelId,
                        client: poller.client,
                        commandKind,
                        commandUsage,
                        message,
                        principalId,
                        registration: selected,
                        update,
                    });
                    return;
                }
            }

            const isPrivateChat = message.chat.type === "private";
            let candidates: TelegramRuntimeRegistration[];

            if (isPrivateChat) {
                candidates = registrations.filter((registration) =>
                    registration.binding.config.allowDMs !== false &&
                    this.authorizedIdentityService.isAuthorizedPrincipal(
                        {
                            id: principalId,
                            linkedPubkey: identityBinding?.linkedPubkey,
                        },
                        registration.binding.config.authorizedIdentityIds
                    )
                );
            } else {
                const exactMatches = registrations.filter((registration) =>
                    matchesTelegramChatBinding(registration.binding.chatBindings, chatId, topicId)
                );
                candidates = exactMatches.length > 0 ? exactMatches : registrations;
                if (commandKind) {
                    candidates = candidates.filter((registration) =>
                        this.isAuthorizedConfigPrincipal(
                            principalId,
                            identityBinding?.linkedPubkey,
                            registration
                        )
                    );
                }
            }

            activeSpan?.addEvent("telegram.candidate_resolution", {
                "telegram.candidate.count": candidates.length,
                "telegram.chat.is_private": isPrivateChat,
            });

            if (candidates.length === 0) {
                if (commandKind) {
                    await sendUnauthorizedTelegramConfigReply(poller.client, message);
                    recordTelegramOutcome("dropped", "unauthorized_config_command", {
                        "telegram.chat.is_private": isPrivateChat,
                    });
                    return;
                }
                recordTelegramOutcome("dropped", "no_matching_candidate", {
                    "telegram.chat.is_private": isPrivateChat,
                });
                return;
            }

            if (candidates.length === 1) {
                const selectedCandidate = candidates[0];
                if (!selectedCandidate) {
                    recordTelegramOutcome("dropped", "missing_selected_candidate");
                    return;
                }

                activeSpan?.setAttributes({
                    "project.id": selectedCandidate.projectId,
                    "project.title": selectedCandidate.projectTitle,
                });

                await this.bindChannelToRegistration(selectedCandidate, channelId, message);
                await this.handleSelectedRegistration({
                    botIdentity: poller.botIdentity,
                    channelId,
                    client: poller.client,
                    commandKind,
                    commandUsage,
                    message,
                    principalId,
                    registration: selectedCandidate,
                    update,
                });
                return;
            }

            recordTelegramOutcome("pending-binding", "project_selection_required", {
                "telegram.candidate.count": candidates.length,
            });
            await this.sendProjectSelectionPrompt(poller, candidates, message, false);
            this.pendingBindingStore.rememberPending({
                agentPubkey,
                channelId,
                projects: candidates.map((registration) => ({
                    projectId: registration.projectId,
                    title: registration.projectTitle,
                })),
                requestedAt: Date.now(),
            });
        });
    }

    private async handleSelectedRegistration(params: {
        botIdentity?: TelegramBotIdentity;
        channelId: string;
        client: TelegramBotClient;
        commandKind?: "model" | "tools";
        commandUsage?: string;
        message: TelegramMessage;
        principalId: string;
        registration: TelegramRuntimeRegistration;
        update: TelegramUpdate;
    }): Promise<void> {
        if (params.commandKind) {
            if (params.commandUsage) {
                await params.client.sendMessage({
                    chatId: String(params.message.chat.id),
                    text: params.commandUsage,
                    replyToMessageId: String(params.message.message_id),
                    messageThreadId: params.message.message_thread_id !== undefined
                        ? String(params.message.message_thread_id)
                        : undefined,
                });
                return;
            }

            const commandKind = params.commandKind;
            if (!commandKind) {
                return;
            }

            await params.registration.runInProjectContext(async () => {
                const projectContext = projectContextStore.getContextOrThrow();
                const agent = params.registration.binding.agent as AgentInstance;
                await this.configCommandService.openCommandMenu({
                    binding: params.registration.binding,
                    client: params.client,
                    commandKind,
                    currentModel: agent.llmConfig,
                    currentTools: agent.tools,
                    message: params.message,
                    principalId: params.principalId,
                    projectBinding: params.registration.projectBinding,
                    projectContext,
                    projectId: params.registration.projectId,
                    projectTitle: params.registration.projectTitle,
                });
            });

            recordTelegramOutcome("routed", "config_command_opened", {
                "project.id": params.registration.projectId,
                "telegram.channel.id": params.channelId,
            });
            return;
        }

        await this.routeUpdateToRegistration(
            params.registration,
            params.update,
            params.channelId,
            params.client,
            params.botIdentity
        );
    }

    private isAuthorizedConfigPrincipal(
        principalId: string,
        linkedPubkey: string | undefined,
        registration: TelegramRuntimeRegistration
    ): boolean {
        return this.authorizedIdentityService.isAuthorizedPrincipal(
            {
                id: principalId,
                linkedPubkey,
            },
            registration.binding.config.authorizedIdentityIds
        );
    }

    private async routeUpdateToRegistration(
        registration: TelegramRuntimeRegistration,
        update: TelegramUpdate,
        channelId: string,
        client: TelegramBotClient,
        botIdentity?: TelegramBotIdentity
    ): Promise<void> {
        const message = normalizeTelegramMessage(update);
        if (!message) {
            return;
        }

        const session = this.channelSessionStore.findSessionByAgentChannel(
            registration.binding.agent.pubkey,
            channelId
        );
        const transportMetadata = await this.buildTransportMetadata({
            registration,
            channelId,
            client,
            message,
            update,
            botIdentity,
        });
        const { envelope } = this.inboundAdapter.toEnvelope({
            update,
            binding: registration.binding,
            projectBinding: registration.projectBinding,
            replyToNativeMessageId: session?.lastMessageId,
            botIdentity,
            transportMetadata,
        });

        await registration.runInProjectContext(async () => {
            const activeSpan = trace.getActiveSpan();
            activeSpan?.setAttributes({
                "project.id": registration.projectId,
                "project.title": registration.projectTitle,
                "agent.slug": registration.binding.agent.slug,
                "agent.pubkey": registration.binding.agent.pubkey,
                "telegram.channel.id": channelId,
                "telegram.message.content": envelope.content,
                "telegram.session.conversation_id": session?.conversationId ?? "",
            });
            activeSpan?.addEvent("telegram.envelope.created", {
                "telegram.channel.id": channelId,
                "runtime.message.id": envelope.message.id,
                "runtime.reply_to_id": envelope.message.replyToId ?? "",
            });

            await this.sendTypingIndicator(client, registration, message);

            if (session?.conversationId) {
                ConversationStore.getOrLoad(session.conversationId);
            }

            await this.runtimeIngressService.handleChatMessage({
                envelope,
                agentExecutor: registration.agentExecutor,
                adapter: this.inboundAdapter.constructor.name,
            });

            const conversation = ConversationStore.findByEventId(envelope.message.nativeId);
            if (!conversation) {
                throw new Error(
                    `Telegram update ${update.update_id} did not resolve a conversation for project ${registration.projectId}`
                );
            }

            activeSpan?.setAttributes({
                "conversation.id": conversation.id,
            });
            activeSpan?.addEvent("telegram.conversation.resolved", {
                "conversation.id": conversation.id,
                "project.id": registration.projectId,
            });

            this.channelSessionStore.rememberSession({
                projectId: registration.projectId,
                agentPubkey: registration.binding.agent.pubkey,
                channelId,
                conversationId: conversation.id,
                lastMessageId: envelope.message.nativeId,
            });
            this.channelBindingStore.rememberBinding({
                agentPubkey: registration.binding.agent.pubkey,
                channelId,
                projectId: registration.projectId,
            });
            this.pendingBindingStore.clearPending(registration.binding.agent.pubkey, channelId);

            recordTelegramOutcome("routed", "routed_to_runtime", {
                "conversation.id": conversation.id,
                "project.id": registration.projectId,
            });

            logger.info("[TelegramGatewayCoordinator] Routed Telegram update", withActiveTraceLogFields({
                projectId: registration.projectId,
                projectTitle: registration.projectTitle,
                agentSlug: registration.binding.agent.slug,
                updateId: update.update_id,
                principalId: envelope.principal.id,
                channelId,
                conversationId: conversation.id,
                content: envelope.content,
            }));
        });
    }

    private async buildTransportMetadata(params: {
        registration: TelegramRuntimeRegistration;
        channelId: string;
        client: TelegramBotClient;
        message: TelegramMessage;
        update: TelegramUpdate;
        botIdentity?: TelegramBotIdentity;
    }) {
        const chatContext = params.message.chat.type === "private"
            ? undefined
            : await this.chatContextService.rememberChatContext({
                projectId: params.registration.projectId,
                agentPubkey: params.registration.binding.agent.pubkey,
                channelId: params.channelId,
                message: params.message,
                client: params.client,
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

    private async bindChannelToRegistration(
        registration: TelegramRuntimeRegistration,
        channelId: string,
        message: TelegramMessage
    ): Promise<void> {
        await registration.runInProjectContext(async () => {
            const projectContext = projectContextStore.getContextOrThrow();
            await this.bindingPersistenceService.rememberProjectBinding({
                projectId: registration.projectId,
                binding: registration.binding,
                channelId,
                message,
                projectContext,
            });
        });
    }

    private async sendTypingIndicator(
        client: TelegramBotClient,
        registration: TelegramRuntimeRegistration,
        message: TelegramMessage
    ): Promise<void> {
        const activeSpan = trace.getActiveSpan();
        activeSpan?.addEvent("telegram.typing_indicator.requested", {
            "project.id": registration.projectId,
            "agent.slug": registration.binding.agent.slug,
            "telegram.chat.id": String(message.chat.id),
            "telegram.message.id": String(message.message_id),
        });
        try {
            await client.sendChatAction({
                chatId: String(message.chat.id),
                action: "typing",
                messageThreadId: normalizeTelegramTopicId(message.message_thread_id),
            });
            activeSpan?.addEvent("telegram.typing_indicator.sent", {
                "telegram.chat.id": String(message.chat.id),
                "telegram.message.id": String(message.message_id),
            });
        } catch (error) {
            logger.warn("[TelegramGatewayCoordinator] Failed to send typing indicator", withActiveTraceLogFields({
                projectId: registration.projectId,
                projectTitle: registration.projectTitle,
                agentSlug: registration.binding.agent.slug,
                chatId: String(message.chat.id),
                messageId: message.message_id,
                error: error instanceof Error ? error.message : String(error),
            }));
        }
    }

    private async sendProjectSelectionPrompt(
        poller: TelegramPollerState,
        registrations: TelegramRuntimeRegistration[],
        message: TelegramMessage,
        isReminder: boolean
    ): Promise<void> {
        const lines = [
            isReminder
                ? "I still need to know which project this chat should be bound to."
                : "This chat is not bound to a project yet.",
            "Reply with one of these numbers:",
            ...registrations.map(
                (registration, index) => `${index + 1}. ${registration.projectTitle} (${registration.projectId})`
            ),
        ];

        trace.getActiveSpan()?.addEvent("telegram.project_selection_prompt", {
            "telegram.project_selection.is_reminder": isReminder,
            "telegram.project_selection.candidate_count": registrations.length,
        });

        await poller.client.sendMessage({
            chatId: String(message.chat.id),
            text: lines.join("\n"),
            replyToMessageId: String(message.message_id),
            messageThreadId: normalizeTelegramTopicId(message.message_thread_id),
        });
    }
}

export const getTelegramGatewayCoordinator = (): TelegramGatewayCoordinator =>
    TelegramGatewayCoordinator.getInstance();
