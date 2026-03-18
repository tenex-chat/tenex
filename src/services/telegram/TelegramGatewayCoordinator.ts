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
import {
    type TelegramBotIdentity,
    type TelegramGatewayBinding,
    type TelegramMessage,
    type TelegramUpdate,
} from "@/services/telegram/types";
import { getTelegramChannelBindingStore } from "@/services/telegram/TelegramChannelBindingStoreService";
import { getTelegramPendingBindingStore } from "@/services/telegram/TelegramPendingBindingStoreService";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import { TelegramInboundAdapter } from "@/services/telegram/TelegramInboundAdapter";
import { createTelegramChannelId } from "@/lib/telegram-identifiers";
import { logger } from "@/utils/logger";

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

function normalizeChatId(chatId: string | number): string {
    return String(chatId);
}

function normalizeTopicId(topicId: string | number | undefined): string | undefined {
    return topicId === undefined ? undefined : String(topicId);
}

function normalizeMessage(update: TelegramUpdate): TelegramMessage | undefined {
    return update.message ?? update.edited_message;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTextualMessage(message: TelegramMessage): boolean {
    return Boolean(message.text?.trim() || message.caption?.trim());
}

function isSupportedChatType(message: TelegramMessage): boolean {
    return message.chat.type === "private" ||
        message.chat.type === "group" ||
        message.chat.type === "supergroup";
}

function matchesStaticBinding(
    binding: TelegramGatewayBinding,
    chatId: string,
    topicId?: string
): boolean {
    const chatBindings = binding.chatBindings ?? [];
    if (chatBindings.length === 0) {
        return false;
    }

    return chatBindings.some((chatBinding) => {
        if (chatBinding.chatId !== chatId) {
            return false;
        }

        if (chatBinding.topicId === undefined) {
            return true;
        }

        return chatBinding.topicId === topicId;
    });
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

export class TelegramGatewayCoordinator {
    private static instance: TelegramGatewayCoordinator;

    private readonly registrations = new Map<string, TelegramRuntimeRegistration[]>();
    private readonly pollers = new Map<string, TelegramPollerState>();
    private readonly runtimeIngressService = new RuntimeIngressService();
    private readonly inboundAdapter = new TelegramInboundAdapter();
    private readonly channelSessionStore: ChannelSessionStore = getChannelSessionStore();
    private readonly channelBindingStore = getTelegramChannelBindingStore();
    private readonly pendingBindingStore = getTelegramPendingBindingStore();
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

    private async skipBacklog(client: TelegramBotClient): Promise<number | undefined> {
        let offset: number | undefined;

        while (true) {
            const updates = await client.getUpdates({
                offset,
                timeoutSeconds: 0,
                limit: this.pollLimit,
            });
            if (updates.length === 0) {
                return offset;
            }
            const lastUpdate = updates[updates.length - 1];
            offset = lastUpdate ? lastUpdate.update_id + 1 : offset;
        }
    }

    private async runPollLoop(poller: TelegramPollerState): Promise<void> {
        while (this.pollers.has(poller.token)) {
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
                    try {
                        await this.processUpdate(poller, update);
                    } catch (error) {
                        logger.warn("[TelegramGatewayCoordinator] Failed to process update", {
                            tokenSuffix: poller.token.slice(-6),
                            updateId: update.update_id,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    } finally {
                        poller.nextOffset = update.update_id + 1;
                    }
                }
            } catch (error) {
                if (!this.pollers.has(poller.token) || isAbortError(error)) {
                    break;
                }

                logger.warn("[TelegramGatewayCoordinator] Poll loop error", {
                    tokenSuffix: poller.token.slice(-6),
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

    private async processUpdate(poller: TelegramPollerState, update: TelegramUpdate): Promise<void> {
        const registrations = deduplicateRegistrations(this.registrations.get(poller.token) ?? []);
        if (registrations.length === 0) {
            return;
        }

        const message = normalizeMessage(update);
        if (!message?.from || message.from.is_bot || !isSupportedChatType(message) || !isTextualMessage(message)) {
            return;
        }

        const primaryRegistration = registrations[0];
        if (!primaryRegistration) {
            return;
        }

        const chatId = normalizeChatId(message.chat.id);
        const topicId = normalizeTopicId(message.message_thread_id);
        const channelId = createTelegramChannelId(chatId, topicId);
        const agentPubkey = primaryRegistration.binding.agent.pubkey;
        const principalId = `telegram:user:${message.from.id}`;
        const identityBinding = getIdentityBindingStore().getBinding(principalId);
        const pending = this.pendingBindingStore.getPending(agentPubkey, channelId);

        if (pending) {
            const selected = parseProjectSelection(message.text?.trim() || message.caption?.trim() || "", registrations
                .filter((registration) => pending.projects.some((project) => project.projectId === registration.projectId)));
            if (!selected) {
                await this.sendProjectSelectionPrompt(poller, registrations, message, true);
                return;
            }

            this.channelBindingStore.rememberBinding({
                agentPubkey,
                channelId,
                projectId: selected.projectId,
            });
            this.pendingBindingStore.clearPending(agentPubkey, channelId);

            await poller.client.sendMessage({
                chatId,
                text: `Bound this chat to project "${selected.projectTitle}". Send your next message to continue.`,
                replyToMessageId: String(message.message_id),
                messageThreadId: topicId,
            });
            return;
        }

        const session = this.channelSessionStore.findSessionByAgentChannel(agentPubkey, channelId);
        if (session) {
            const selected = registrations.find((registration) => registration.projectId === session.projectId);
            if (selected) {
                await this.routeUpdateToRegistration(selected, update, channelId, poller.client);
                return;
            }
        }

        const dynamicBinding = this.channelBindingStore.getBinding(agentPubkey, channelId);
        if (dynamicBinding) {
            const selected = registrations.find(
                (registration) => registration.projectId === dynamicBinding.projectId
            );
            if (selected) {
                await this.routeUpdateToRegistration(selected, update, channelId, poller.client);
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
                matchesStaticBinding(registration.binding, chatId, topicId)
            );
            candidates = exactMatches.length > 0 ? exactMatches : registrations;
        }

        if (candidates.length === 0) {
            return;
        }

        if (candidates.length === 1) {
            const selectedCandidate = candidates[0];
            if (!selectedCandidate) {
                return;
            }

            this.channelBindingStore.rememberBinding({
                agentPubkey,
                channelId,
                projectId: selectedCandidate.projectId,
            });
            await this.routeUpdateToRegistration(selectedCandidate, update, channelId, poller.client);
            return;
        }

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
    }

    private async routeUpdateToRegistration(
        registration: TelegramRuntimeRegistration,
        update: TelegramUpdate,
        channelId: string,
        client: TelegramBotClient
    ): Promise<void> {
        const message = normalizeMessage(update);
        if (!message) {
            return;
        }

        const session = this.channelSessionStore.findSessionByAgentChannel(
            registration.binding.agent.pubkey,
            channelId
        );
        const { envelope } = this.inboundAdapter.toEnvelope({
            update,
            binding: registration.binding,
            projectBinding: registration.projectBinding,
            replyToNativeMessageId: session?.lastMessageId,
        });

        await registration.runInProjectContext(async () => {
            await this.sendTypingIndicator(client, registration, message);

            if (session?.conversationId) {
                ConversationStore.getOrLoad(session.conversationId);
            }

            const legacyEvent = await this.runtimeIngressService.handleChatMessage({
                envelope,
                agentExecutor: registration.agentExecutor,
                adapter: this.inboundAdapter.constructor.name,
            });

            const conversation = ConversationStore.findByEventId(legacyEvent.id ?? "");
            if (!conversation) {
                throw new Error(
                    `Telegram update ${update.update_id} did not resolve a conversation for project ${registration.projectId}`
                );
            }

            this.channelSessionStore.rememberSession({
                projectId: registration.projectId,
                agentPubkey: registration.binding.agent.pubkey,
                channelId,
                conversationId: conversation.id,
                lastMessageId: legacyEvent.id ?? envelope.message.nativeId,
            });
            this.channelBindingStore.rememberBinding({
                agentPubkey: registration.binding.agent.pubkey,
                channelId,
                projectId: registration.projectId,
            });
            this.pendingBindingStore.clearPending(registration.binding.agent.pubkey, channelId);

            logger.info("[TelegramGatewayCoordinator] Routed Telegram update", {
                projectId: registration.projectId,
                projectTitle: registration.projectTitle,
                agentSlug: registration.binding.agent.slug,
                updateId: update.update_id,
                principalId: envelope.principal.id,
                channelId,
                conversationId: conversation.id,
            });
        });
    }

    private async sendTypingIndicator(
        client: TelegramBotClient,
        registration: TelegramRuntimeRegistration,
        message: TelegramMessage
    ): Promise<void> {
        try {
            await client.sendChatAction({
                chatId: String(message.chat.id),
                action: "typing",
                messageThreadId: normalizeTopicId(message.message_thread_id),
            });
        } catch (error) {
            logger.warn("[TelegramGatewayCoordinator] Failed to send typing indicator", {
                projectId: registration.projectId,
                projectTitle: registration.projectTitle,
                agentSlug: registration.binding.agent.slug,
                chatId: String(message.chat.id),
                messageId: message.message_id,
                error: error instanceof Error ? error.message : String(error),
            });
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

        await poller.client.sendMessage({
            chatId: String(message.chat.id),
            text: lines.join("\n"),
            replyToMessageId: String(message.message_id),
            messageThreadId: normalizeTopicId(message.message_thread_id),
        });
    }
}

export const getTelegramGatewayCoordinator = (): TelegramGatewayCoordinator =>
    TelegramGatewayCoordinator.getInstance();
