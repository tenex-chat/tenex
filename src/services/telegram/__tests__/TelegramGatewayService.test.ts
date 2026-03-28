import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentRegistry } from "@/agents/AgentRegistry";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { projectContextStore } from "@/services/projects";
import type { TelegramBindingPersistenceService } from "@/services/telegram/TelegramBindingPersistenceService";
import {
    TELEGRAM_BOT_COMMANDS,
    TELEGRAM_NEW_CONVERSATION_SUCCESS_MESSAGE,
    TELEGRAM_NEW_CONVERSATION_USAGE_MESSAGE,
    TelegramConfigCommandService,
} from "@/services/telegram/TelegramConfigCommandService";
import { TelegramGatewayService } from "@/services/telegram/TelegramGatewayService";
import type { TelegramGatewayBinding, TelegramUpdate } from "@/services/telegram/types";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NDKEvent } from "@nostr-dev-kit/ndk";

function createAgent(overrides: Partial<any> = {}) {
    return {
        slug: "telegram-agent",
        name: "Telegram Agent",
        pubkey: "a".repeat(64),
        llmConfig: "model-a",
        tools: ["fs_read"],
        telegram: {
            botToken: "shared-token",
            apiBaseUrl: "https://telegram.example",
            allowDMs: true,
            ...(overrides.telegram ?? {}),
        },
        ...overrides,
    };
}

function createProjectContext(agent: any, projectId: string, projectTitle: string) {
    const agents = new Map([[agent.slug, agent]]);
    return {
        agents,
        agentRegistry: {
            getBasePath: () => "/tmp/project",
        } as unknown as AgentRegistry,
        mcpManager: undefined,
        project: {
            id: `project-${projectId}`,
            tagValue: (name: string) => {
                if (name === "d") {
                    return projectId;
                }
                if (name === "title") {
                    return projectTitle;
                }
                return undefined;
            },
            tagReference: () => ["a", `31933:${"f".repeat(64)}:${projectId}`],
        },
    } as any;
}

function createRegistration(projectId: string, projectTitle: string, agent = createAgent()) {
    const projectContext = createProjectContext(agent, projectId, projectTitle);
    return {
        projectId,
        projectTitle,
        projectBinding: `31933:${"f".repeat(64)}:${projectId}`,
        runInProjectContext: async <T>(operation: () => Promise<T>) =>
            await projectContextStore.run(projectContext, operation),
        agentExecutor: {} as any,
        binding: {
            agent,
            config: agent.telegram,
        },
    };
}

function createPrivateUpdate(updateId: number, messageId: number, text: string): TelegramUpdate {
    return {
        update_id: updateId,
        message: {
            message_id: messageId,
            date: 123 + updateId,
            chat: { id: 1001, type: "private" },
            from: {
                id: 42,
                is_bot: false,
                first_name: "Alice",
            },
            text,
        },
    };
}

function createGroupUpdate(
    updateId: number,
    messageId: number,
    text: string,
    options: {
        chatId?: number;
        threadId?: number;
        firstName?: string;
    } = {}
): TelegramUpdate {
    return {
        update_id: updateId,
        message: {
            message_id: messageId,
            date: 123 + updateId,
            message_thread_id: options.threadId,
            chat: {
                id: options.chatId ?? -2001,
                type: "supergroup",
                title: "Operators",
            },
            from: {
                id: 55,
                is_bot: false,
                first_name: options.firstName ?? "Bob",
            },
            text,
        },
    };
}

function createPrivateVoiceUpdate(updateId: number): TelegramUpdate {
    return {
        update_id: updateId,
        message: {
            message_id: updateId + 40,
            date: 123,
            chat: {
                id: 1001,
                type: "private",
            },
            from: {
                id: 42,
                is_bot: false,
                first_name: "Alice",
            },
            voice: {
                file_id: "voice-file-id",
                file_unique_id: "voice-unique-id",
                duration: 7,
                mime_type: "audio/ogg",
            },
        },
    };
}

function createCallbackUpdate(updateId: number): TelegramUpdate {
    return {
        update_id: updateId,
        callback_query: {
            id: `callback-${updateId}`,
            from: {
                id: 42,
                is_bot: false,
                first_name: "Alice",
            },
            data: "tgcfg:session:cancel",
            message: {
                message_id: 900 + updateId,
                date: 123 + updateId,
                chat: { id: 1001, type: "private" },
                from: {
                    id: 101,
                    is_bot: true,
                    first_name: "test-bot",
                },
                text: "config menu",
            },
        },
    };
}

function createSessionStore() {
    const sessions = new Map<string, any>();
    const key = (projectId: string, agentPubkey: string, channelId: string) =>
        `${projectId}::${agentPubkey}::${channelId}`;

    return {
        getSession: (projectId: string, agentPubkey: string, channelId: string) =>
            sessions.get(key(projectId, agentPubkey, channelId)),
        findSessionByAgentChannel: (agentPubkey: string, channelId: string) =>
            Array.from(sessions.values()).find((session) =>
                session.agentPubkey === agentPubkey && session.channelId === channelId
            ),
        rememberSession: mock((session: any) => {
            const next = {
                ...session,
                updatedAt: Date.now(),
            };
            sessions.set(key(session.projectId, session.agentPubkey, session.channelId), next);
            return next;
        }),
        clearSession: mock((projectId: string, agentPubkey: string, channelId: string) =>
            sessions.delete(key(projectId, agentPubkey, channelId))
        ),
        clearSessionsByAgentChannel: mock((agentPubkey: string, channelId: string) => {
            let deleted = 0;
            for (const [sessionKey, session] of sessions.entries()) {
                if (session.agentPubkey !== agentPubkey || session.channelId !== channelId) {
                    continue;
                }
                sessions.delete(sessionKey);
                deleted += 1;
            }
            return deleted;
        }),
    };
}

function createBindingStore() {
    const bindings = new Map<string, { projectId: string }>();
    const key = (agentPubkey: string, channelId: string) => `${agentPubkey}::${channelId}`;

    return {
        bindings,
        getBinding: (agentPubkey: string, channelId: string) => bindings.get(key(agentPubkey, channelId)),
        rememberBinding: mock((record: { agentPubkey: string; channelId: string; projectId: string }) => {
            bindings.set(key(record.agentPubkey, record.channelId), {
                projectId: record.projectId,
            });
            return record;
        }),
        clearBinding: mock((agentPubkey: string, channelId: string) => {
            bindings.delete(key(agentPubkey, channelId));
        }),
    };
}

function createPendingStore() {
    const pending = new Map<string, any>();
    const key = (agentPubkey: string, channelId: string) => `${agentPubkey}::${channelId}`;

    return {
        pending,
        getPending: (agentPubkey: string, channelId: string) => pending.get(key(agentPubkey, channelId)),
        rememberPending: mock((record: any) => {
            pending.set(key(record.agentPubkey, record.channelId), record);
            return record;
        }),
        clearPending: mock((agentPubkey: string, channelId: string) => {
            pending.delete(key(agentPubkey, channelId));
        }),
    };
}

function createPoller(agent = createAgent()) {
    const client = {
        sendMessage: mock(async () => undefined),
        sendChatAction: mock(async () => undefined),
    };

    return {
        client,
        poller: {
            token: agent.telegram.botToken,
            agentPubkey: agent.pubkey,
            client,
            botIdentity: {
                id: 101,
                is_bot: true,
                first_name: "test-bot",
                username: "test_bot",
            },
            loopPromise: Promise.resolve(),
        },
    };
}

function initializeConversationStore(tempDirs: string[], suffix: string): void {
    const metadataPath = join(tmpdir(), `telegram-gateway-${Date.now()}-${suffix}`);
    tempDirs.push(metadataPath);
    mkdirSync(join(metadataPath, "conversations"), { recursive: true });
    ConversationStore.initialize(metadataPath, ["a".repeat(64), "b".repeat(64)]);
}

describe("TelegramGatewayService", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        TelegramGatewayService.resetInstance();
        ConversationStore.reset();
        mock.restore();

        for (const dir of tempDirs.splice(0)) {
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it("registers a poller before starting the poll loop", async () => {
        const service = new TelegramGatewayService() as any;
        const registration = createRegistration("project-alpha", "Project Alpha");
        const client = {
            getMe: mock(async () => ({
                id: 101,
                is_bot: true as const,
                first_name: "test-bot",
                username: "test_bot",
            })),
            setMyCommands: mock(async () => undefined),
        };
        let sawRegisteredPoller = false;

        service.clientFactory = () => client;
        service.skipBacklog = async () => undefined;
        service.runPollLoop = async (poller: { token: string }) => {
            sawRegisteredPoller = service.pollers.has(poller.token);
        };

        await service.startPoller("shared-token", registration);

        expect(sawRegisteredPoller).toBe(true);
        expect(service.pollers.has("shared-token")).toBe(true);
        expect(client.setMyCommands).toHaveBeenCalledWith({
            commands: TELEGRAM_BOT_COMMANDS,
        });
    });

    it("rejects shared tokens across different agent identities", async () => {
        const service = new TelegramGatewayService() as any;
        service.startPoller = mock(async () => undefined);
        const alpha = createAgent();
        const beta = createAgent({
            slug: "other-agent",
            name: "Other Agent",
            pubkey: "b".repeat(64),
        });

        await service.registerRuntime({
            projectId: "project-alpha",
            projectTitle: "Project Alpha",
            projectBinding: `31933:${"f".repeat(64)}:project-alpha`,
            agents: [alpha],
            runInProjectContext: async <T>(operation: () => Promise<T>) => await operation(),
            agentExecutor: {} as any,
        });

        await expect(service.registerRuntime({
            projectId: "project-beta",
            projectTitle: "Project Beta",
            projectBinding: `31933:${"f".repeat(64)}:project-beta`,
            agents: [beta],
            runInProjectContext: async <T>(operation: () => Promise<T>) => await operation(),
            agentExecutor: {} as any,
        })).rejects.toThrow("Telegram bot token is assigned to multiple agent identities");
    });

    it("routes authorized DMs and persists channel session continuity", async () => {
        initializeConversationStore(tempDirs, "authorized-dm");
        const agent = createAgent();
        const registration = createRegistration("telegram-project", "Telegram Project", agent);
        const sessionStore = createSessionStore();
        const bindingStore = createBindingStore();
        const pendingStore = createPendingStore();
        const runtimeIngress = {
            handleChatMessage: mock(async ({ envelope }: { envelope: InboundEnvelope }) => {
                const event = new NDKEvent();
                event.id = envelope.message.nativeId;
                event.pubkey = envelope.principal.linkedPubkey ?? "1".repeat(64);
                event.content = envelope.content;
                event.tags = [["p", agent.pubkey]];

                const conversation = ConversationStore.getOrLoad("conversation-dm");
                conversation.addMessage({
                    pubkey: event.pubkey,
                    content: event.content,
                    eventId: event.id,
                    messageType: "text",
                    senderPrincipal: envelope.principal,
                    targetedPrincipals: envelope.recipients,
                    timestamp: envelope.occurredAt,
                });
                await conversation.save();
            }),
        };
        const service = new TelegramGatewayService({
            runtimeIngressService: runtimeIngress,
            channelSessionStore: sessionStore as any,
            channelBindingStore: bindingStore as any,
            pendingBindingStore: pendingStore as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => true,
            } as any,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [registration]);
        const { poller } = createPoller(agent);

        await service.processUpdate(poller, createPrivateUpdate(10, 5, "hello dm"));

        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(1);
        expect(
            sessionStore.getSession("telegram-project", agent.pubkey, "telegram:chat:1001")
        ).toMatchObject({
            conversationId: "conversation-dm",
            lastMessageId: "tg_1001_5",
        });
    });

    it("drops unauthorized DMs", async () => {
        const agent = createAgent();
        const registration = createRegistration("telegram-project", "Telegram Project", agent);
        const service = new TelegramGatewayService({
            channelSessionStore: createSessionStore() as any,
            channelBindingStore: createBindingStore() as any,
            pendingBindingStore: createPendingStore() as any,
            runtimeIngressService: {
                handleChatMessage: mock(async () => {
                    throw new Error("runtime ingress should not run");
                }),
            },
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => false,
            } as any,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [registration]);
        const { poller } = createPoller(agent);

        await service.processUpdate(poller, createPrivateUpdate(11, 6, "hello unauthorized"));

        expect(service.runtimeIngressService.handleChatMessage).toHaveBeenCalledTimes(0);
    });

    it("routes bound group messages with unified metadata including topic titles", async () => {
        initializeConversationStore(tempDirs, "bound-group");
        const agent = createAgent({
            telegram: {
                botToken: "shared-token",
                apiBaseUrl: "https://telegram.example",
            },
        });
        const registration = createRegistration("telegram-project", "Telegram Project", agent);
        const sessionStore = createSessionStore();
        const bindingStore = createBindingStore();
        const pendingStore = createPendingStore();
        bindingStore.rememberBinding({
            transport: "telegram",
            agentPubkey: agent.pubkey,
            channelId: "telegram:chat:-2001:topic:55",
            projectId: "telegram-project",
        } as any);

        const runtimeIngress = {
            handleChatMessage: mock(async ({ envelope }: { envelope: InboundEnvelope }) => {
                expect(envelope.metadata.transport?.telegram).toMatchObject({
                    chatTitle: "Operators",
                    topicTitle: "Deployments",
                    memberCount: 14,
                    administrators: [{
                        userId: "7",
                        displayName: "Ada",
                    }],
                    seenParticipants: [{
                        userId: "55",
                        displayName: "Bob",
                    }],
                });
                const event = new NDKEvent();
                event.id = envelope.message.nativeId;
                event.pubkey = envelope.principal.linkedPubkey ?? "2".repeat(64);
                event.content = envelope.content;
                event.tags = [["p", agent.pubkey]];

                const conversation = ConversationStore.getOrLoad("conversation-group");
                conversation.addMessage({
                    pubkey: event.pubkey,
                    content: event.content,
                    eventId: event.id,
                    messageType: "text",
                    senderPrincipal: envelope.principal,
                    targetedPrincipals: envelope.recipients,
                    timestamp: envelope.occurredAt,
                });
                await conversation.save();
            }),
        };

        const service = new TelegramGatewayService({
            runtimeIngressService: runtimeIngress,
            channelSessionStore: sessionStore as any,
            channelBindingStore: bindingStore as any,
            pendingBindingStore: pendingStore as any,
            chatContextService: {
                rememberChatContext: mock(async () => ({
                    projectId: "telegram-project",
                    agentPubkey: agent.pubkey,
                    channelId: "telegram:chat:-2001:topic:55",
                    chatId: "-2001",
                    chatTitle: "Operators",
                    topicTitle: "Deployments",
                    memberCount: 14,
                    administrators: [{
                        userId: "7",
                        displayName: "Ada",
                    }],
                    seenParticipants: [{
                        userId: "55",
                        displayName: "Bob",
                        lastSeenAt: 125,
                    }],
                    updatedAt: 125,
                })),
            } as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => false,
            } as any,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [registration]);
        const { poller } = createPoller(agent);

        await service.processUpdate(
            poller,
            createGroupUpdate(12, 7, "hello group", { threadId: 55 })
        );

        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(1);
    });

    it("auto-binds first-contact groups when there is a single project candidate", async () => {
        const agent = createAgent();
        const registration = createRegistration("project-alpha", "Project Alpha", agent);
        const rememberProjectBinding = mock(async ({ binding }: { binding: typeof registration.binding }) => binding);
        const service = new TelegramGatewayService({
            channelSessionStore: createSessionStore() as any,
            channelBindingStore: createBindingStore() as any,
            pendingBindingStore: createPendingStore() as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => true,
            } as any,
            bindingPersistenceService: {
                rememberProjectBinding,
            } satisfies Pick<TelegramBindingPersistenceService, "rememberProjectBinding">,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [registration]);
        service.routeUpdateToRegistration = mock(async () => undefined);
        const { poller } = createPoller(agent);

        await service.processUpdate(poller, createGroupUpdate(13, 8, "hello group"));

        expect(rememberProjectBinding).toHaveBeenCalledTimes(1);
        expect(service.routeUpdateToRegistration).toHaveBeenCalledTimes(1);
        expect(service.pendingBindingStore.rememberPending).toHaveBeenCalledTimes(0);
    });

    it("prompts for project ambiguity and persists the selected project after a numeric reply", async () => {
        const agent = createAgent();
        const alpha = createRegistration("project-alpha", "Project Alpha", agent);
        const beta = createRegistration("project-beta", "Project Beta", agent);
        const rememberProjectBinding = mock(async ({ binding }: { binding: typeof alpha.binding }) => binding);
        const pendingStore = createPendingStore();
        const service = new TelegramGatewayService({
            channelSessionStore: createSessionStore() as any,
            channelBindingStore: createBindingStore() as any,
            pendingBindingStore: pendingStore as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => true,
            } as any,
            bindingPersistenceService: {
                rememberProjectBinding,
            } satisfies Pick<TelegramBindingPersistenceService, "rememberProjectBinding">,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [alpha, beta]);
        service.routeUpdateToRegistration = mock(async () => undefined);
        const { poller, client } = createPoller(agent);

        await service.processUpdate(poller, createGroupUpdate(14, 9, "hello group"));

        expect(client.sendMessage).toHaveBeenCalledTimes(1);
        expect(client.sendMessage.mock.calls[0]?.[0]?.text).toContain("Reply with one of these numbers:");
        expect(pendingStore.rememberPending).toHaveBeenCalledTimes(1);
        expect(rememberProjectBinding).toHaveBeenCalledTimes(0);

        await service.processUpdate(poller, createGroupUpdate(15, 10, "2"));

        expect(rememberProjectBinding).toHaveBeenCalledTimes(1);
        expect(rememberProjectBinding.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            projectId: "project-beta",
            channelId: "telegram:chat:-2001",
        }));
        expect(client.sendMessage.mock.calls[1]?.[0]?.text).toContain('Bound this chat to project "Project Beta"');
        expect(service.routeUpdateToRegistration).toHaveBeenCalledTimes(0);
    });

    it("clears pending selection on /new without re-prompting", async () => {
        const agent = createAgent();
        const alpha = createRegistration("project-alpha", "Project Alpha", agent);
        const beta = createRegistration("project-beta", "Project Beta", agent);
        const sessionStore = createSessionStore();
        const pendingStore = createPendingStore();
        pendingStore.rememberPending({
            agentPubkey: agent.pubkey,
            channelId: "telegram:chat:-2001",
            projects: [
                { projectId: alpha.projectId, title: alpha.projectTitle },
                { projectId: beta.projectId, title: beta.projectTitle },
            ],
            requestedAt: Date.now(),
        });

        const service = new TelegramGatewayService({
            channelSessionStore: sessionStore as any,
            channelBindingStore: createBindingStore() as any,
            pendingBindingStore: pendingStore as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => true,
            } as any,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [alpha, beta]);
        service.routeUpdateToRegistration = mock(async () => undefined);
        const { poller, client } = createPoller(agent);

        await service.processUpdate(poller, createGroupUpdate(16, 11, "/new"));

        expect(pendingStore.clearPending).toHaveBeenCalledWith(
            agent.pubkey,
            "telegram:chat:-2001"
        );
        expect(sessionStore.clearSessionsByAgentChannel).toHaveBeenCalledWith(
            agent.pubkey,
            "telegram:chat:-2001"
        );
        expect(pendingStore.rememberPending).toHaveBeenCalledTimes(1);
        expect(service.routeUpdateToRegistration).toHaveBeenCalledTimes(0);
        expect(client.sendMessage).toHaveBeenCalledWith({
            chatId: "-2001",
            text: TELEGRAM_NEW_CONVERSATION_SUCCESS_MESSAGE,
            replyToMessageId: "11",
            messageThreadId: undefined,
        });
    });

    it("resets bound DM continuity on /new and lets the next message start a fresh root", async () => {
        initializeConversationStore(tempDirs, "new-dm");
        const agent = createAgent();
        const registration = createRegistration("telegram-project", "Telegram Project", agent);
        const sessionStore = createSessionStore();
        sessionStore.rememberSession({
            projectId: "telegram-project",
            agentPubkey: agent.pubkey,
            channelId: "telegram:chat:1001",
            conversationId: "conversation-old",
            lastMessageId: "tg_1001_5",
        });
        const bindingStore = createBindingStore();
        const pendingStore = createPendingStore();
        const replyToIds: Array<string | undefined> = [];
        const runtimeIngress = {
            handleChatMessage: mock(async ({ envelope }: { envelope: InboundEnvelope }) => {
                replyToIds.push(envelope.message.replyToId);
                const conversation = ConversationStore.getOrLoad(`conversation-${envelope.message.nativeId}`);
                conversation.addMessage({
                    pubkey: envelope.principal.linkedPubkey ?? "1".repeat(64),
                    content: envelope.content,
                    eventId: envelope.message.nativeId,
                    messageType: "text",
                    senderPrincipal: envelope.principal,
                    targetedPrincipals: envelope.recipients,
                    timestamp: envelope.occurredAt,
                });
                await conversation.save();
            }),
        };
        const service = new TelegramGatewayService({
            runtimeIngressService: runtimeIngress,
            channelSessionStore: sessionStore as any,
            channelBindingStore: bindingStore as any,
            pendingBindingStore: pendingStore as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => true,
            } as any,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [registration]);
        const { poller, client } = createPoller(agent);

        await service.processUpdate(poller, createPrivateUpdate(17, 12, "/new"));

        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(0);
        expect(client.sendMessage).toHaveBeenCalledWith({
            chatId: "1001",
            text: TELEGRAM_NEW_CONVERSATION_SUCCESS_MESSAGE,
            replyToMessageId: "12",
            messageThreadId: undefined,
        });
        expect(
            sessionStore.getSession("telegram-project", agent.pubkey, "telegram:chat:1001")
        ).toBeUndefined();

        await service.processUpdate(poller, createPrivateUpdate(18, 13, "fresh start"));

        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(1);
        expect(replyToIds).toEqual([undefined]);
    });

    it("rejects unauthorized /config commands in groups before runtime routing", async () => {
        const agent = createAgent();
        const registration = createRegistration("telegram-project", "Telegram Project", agent);
        const openCommandMenu = spyOn(
            TelegramConfigCommandService.prototype,
            "openCommandMenu"
        ).mockResolvedValue();
        const runtimeIngress = {
            handleChatMessage: mock(async () => {
                throw new Error("runtime ingress should not run");
            }),
        };
        const service = new TelegramGatewayService({
            runtimeIngressService: runtimeIngress,
            channelSessionStore: createSessionStore() as any,
            channelBindingStore: createBindingStore() as any,
            pendingBindingStore: createPendingStore() as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => false,
            } as any,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [registration]);
        const { poller, client } = createPoller(agent);

        await service.processUpdate(poller, createGroupUpdate(19, 14, "/config"));

        expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            chatId: "-2001",
            text: "You are not allowed to change this agent's Telegram config.",
            replyToMessageId: "14",
        }));
        expect(openCommandMenu).toHaveBeenCalledTimes(0);
        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(0);
    });

    it("expires config callbacks when the runtime session no longer matches an active project", async () => {
        const agent = createAgent();
        const registration = createRegistration("project-alpha", "Project Alpha", agent);
        const getCallbackContext = spyOn(
            TelegramConfigCommandService.prototype,
            "getCallbackContext"
        ).mockReturnValue({
            action: { type: "cancel" },
            session: {
                id: "session-1",
                kind: "tools",
                projectId: "project-zeta",
                projectTitle: "Project Zeta",
                projectBinding: `31933:${"f".repeat(64)}:project-zeta`,
                agentPubkey: agent.pubkey,
                agentName: agent.name,
                principalId: "telegram:user:42",
                chatId: "1001",
                channelId: "telegram:chat:1001",
                messageId: "99",
                currentPage: 0,
                availableModels: [],
                availableTools: [],
                selectedModel: "model-a",
                selectedTools: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        } as any);
        const handleCallback = spyOn(
            TelegramConfigCommandService.prototype,
            "handleCallback"
        ).mockResolvedValue();

        const service = new TelegramGatewayService({
            channelSessionStore: createSessionStore() as any,
            channelBindingStore: createBindingStore() as any,
            pendingBindingStore: createPendingStore() as any,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [registration]);
        const { poller } = createPoller(agent);

        await service.processUpdate(poller, createCallbackUpdate(20));

        expect(getCallbackContext).toHaveBeenCalledTimes(1);
        expect(handleCallback).toHaveBeenCalledTimes(1);
        expect(handleCallback.mock.calls[0]?.[0]?.callbackContext?.session).toBeUndefined();
    });

    it("routes voice-only updates through the shared media path and sends typing indicators", async () => {
        const agent = createAgent();
        const registration = createRegistration("project-alpha", "Project Alpha", agent);
        const sessionStore = createSessionStore();
        const bindingStore = createBindingStore();
        const pendingStore = createPendingStore();
        let routedEnvelope: any;

        const service = new TelegramGatewayService({
            channelSessionStore: sessionStore as any,
            channelBindingStore: bindingStore as any,
            pendingBindingStore: pendingStore as any,
        }) as any;
        service.mediaDownloadService = {
            download: mock(async () => ({
                localPath: "/tmp/telegram/media/voice-unique-id.ogg",
            })),
        };
        service.runtimeIngressService = {
            handleChatMessage: mock(async ({ envelope }: { envelope: unknown }) => {
                routedEnvelope = envelope;
            }),
        };
        spyOn(ConversationStore, "findByEventId").mockReturnValue({
            id: "conversation-voice",
        } as any);
        const { poller, client } = createPoller(agent);

        await service.routeUpdateToRegistration(
            registration,
            createPrivateVoiceUpdate(101),
            "telegram:chat:1001",
            client,
            poller.botIdentity
        );

        expect(service.mediaDownloadService.download).toHaveBeenCalledWith(
            client,
            "voice-file-id",
            "voice-unique-id",
            "audio/ogg"
        );
        expect(client.sendChatAction).toHaveBeenCalledWith({
            chatId: "1001",
            action: "typing",
            messageThreadId: undefined,
        });
        expect(routedEnvelope.content).toBe(
            "[voice message: /tmp/telegram/media/voice-unique-id.ogg, duration: 7s]"
        );
        expect(service.runtimeIngressService.handleChatMessage).toHaveBeenCalledTimes(1);
        expect(sessionStore.rememberSession).toHaveBeenCalledWith(expect.objectContaining({
            conversationId: "conversation-voice",
            lastMessageId: "tg_1001_141",
        }));
        expect(bindingStore.rememberBinding).toHaveBeenCalledWith(expect.objectContaining({
            agentPubkey: registration.binding.agent.pubkey,
            channelId: "telegram:chat:1001",
            projectId: registration.projectId,
        }));
        expect(pendingStore.clearPending).toHaveBeenCalledWith(
            registration.binding.agent.pubkey,
            "telegram:chat:1001"
        );
    });

    it("treats stale channel bindings as unbound and re-resolves against active projects", async () => {
        const agent = createAgent();
        const registration = createRegistration("project-alpha", "Project Alpha", agent);
        const bindingStore = createBindingStore();
        bindingStore.rememberBinding({
            transport: "telegram",
            agentPubkey: agent.pubkey,
            channelId: "telegram:chat:-2001",
            projectId: "project-stale",
        } as any);
        const rememberProjectBinding = mock(async ({ binding }: { binding: typeof registration.binding }) => binding);

        const service = new TelegramGatewayService({
            channelSessionStore: createSessionStore() as any,
            channelBindingStore: bindingStore as any,
            pendingBindingStore: createPendingStore() as any,
            bindingPersistenceService: {
                rememberProjectBinding,
            } satisfies Pick<TelegramBindingPersistenceService, "rememberProjectBinding">,
        }) as any;
        service.registrations.set(agent.telegram.botToken, [registration]);
        service.routeUpdateToRegistration = mock(async () => undefined);
        const { poller } = createPoller(agent);

        await service.processUpdate(poller, createGroupUpdate(21, 15, "stale binding"));

        expect(bindingStore.clearBinding).toHaveBeenCalledWith(
            agent.pubkey,
            "telegram:chat:-2001",
            "telegram"
        );
        expect(rememberProjectBinding).toHaveBeenCalledTimes(1);
        expect(service.routeUpdateToRegistration).toHaveBeenCalledTimes(1);
    });
});
