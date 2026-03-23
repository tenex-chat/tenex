import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentRegistry } from "@/agents/AgentRegistry";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { ChannelSessionStore } from "@/services/ingress/ChannelSessionStoreService";
import {
    TELEGRAM_CONFIG_BOT_COMMANDS,
    TelegramConfigCommandService,
} from "@/services/telegram/TelegramConfigCommandService";
import { TelegramGatewayService } from "@/services/telegram/TelegramGatewayService";
import type { TelegramGatewayBinding, TelegramUpdate } from "@/services/telegram/types";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NDKEvent } from "@nostr-dev-kit/ndk";

function createProjectContext(agent: any) {
    const agents = new Map([[agent.slug, agent]]);
    return {
        agents,
        agentRegistry: {
            getBasePath: () => "/tmp/project",
        } as unknown as AgentRegistry,
        project: {
            id: "project-event",
            tagValue: (name: string) => (name === "d" ? "telegram-project" : undefined),
            tagReference: () => ["a", `31933:${"f".repeat(64)}:telegram-project`],
        },
    } as any;
}

function createBinding(agent: any): TelegramGatewayBinding {
    return {
        agent,
        config: agent.telegram,
        chatBindings: agent.telegram?.chatBindings ?? [],
    };
}

describe("TelegramGatewayService", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        TelegramGatewayService.resetClaims();
        ConversationStore.reset();
        mock.restore();

        for (const dir of tempDirs.splice(0)) {
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it("routes authorized DMs and persists channel session continuity", async () => {
        const metadataPath = join(tmpdir(), `telegram-gateway-${Date.now()}`);
        const sessionPath = join(metadataPath, "channel-sessions.json");
        tempDirs.push(metadataPath);
        mkdirSync(join(metadataPath, "conversations"), { recursive: true });
        ConversationStore.initialize(metadataPath, ["a".repeat(64)]);

        const agent = {
            slug: "telegram-agent",
            name: "Telegram Agent",
            pubkey: "a".repeat(64),
            telegram: {
                botToken: "token",
                allowDMs: true,
            },
        };
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

                return event;
            }),
        };
        const gateway = new TelegramGatewayService({
            projectId: "telegram-project",
            projectContext: createProjectContext(agent),
            agentExecutor: {} as any,
            runtimeIngressService: runtimeIngress,
            channelSessionStore: new ChannelSessionStore(sessionPath),
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => true,
            } as any,
        });

        await gateway.processUpdate(
            createBinding(agent),
            {
                update_id: 10,
                message: {
                    message_id: 5,
                    date: 123,
                    chat: { id: 1001, type: "private" },
                    from: {
                        id: 42,
                        is_bot: false,
                        first_name: "Alice",
                    },
                    text: "hello dm",
                },
            }
        );

        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(1);
        const session = new ChannelSessionStore(sessionPath).getSession(
            "telegram-project",
            agent.pubkey,
            "telegram:chat:1001"
        );
        expect(session).toMatchObject({
            conversationId: "conversation-dm",
            lastMessageId: "tg_1001_5",
        });
    });

    it("ignores unauthorized DMs", async () => {
        const metadataPath = join(tmpdir(), `telegram-gateway-${Date.now()}-unauthorized`);
        tempDirs.push(metadataPath);
        mkdirSync(join(metadataPath, "conversations"), { recursive: true });
        ConversationStore.initialize(metadataPath, ["a".repeat(64)]);

        const agent = {
            slug: "telegram-agent",
            name: "Telegram Agent",
            pubkey: "a".repeat(64),
            telegram: {
                botToken: "token",
                allowDMs: true,
            },
        };
        const runtimeIngress = {
            handleChatMessage: mock(async () => {
                throw new Error("should not be called");
            }),
        };
        const gateway = new TelegramGatewayService({
            projectId: "telegram-project",
            projectContext: createProjectContext(agent),
            agentExecutor: {} as any,
            runtimeIngressService: runtimeIngress,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => false,
            } as any,
        });

        await gateway.processUpdate(
            createBinding(agent),
            {
                update_id: 11,
                message: {
                    message_id: 6,
                    date: 124,
                    chat: { id: 1002, type: "private" },
                    from: {
                        id: 99,
                        is_bot: false,
                        first_name: "Mallory",
                    },
                    text: "hello unauthorized",
                },
            }
        );

        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(0);
    });

    it("routes bound group messages even when sender identities are not whitelisted", async () => {
        const metadataPath = join(tmpdir(), `telegram-gateway-${Date.now()}-group`);
        tempDirs.push(metadataPath);
        mkdirSync(join(metadataPath, "conversations"), { recursive: true });
        ConversationStore.initialize(metadataPath, ["a".repeat(64)]);

        const agent = {
            slug: "telegram-agent",
            name: "Telegram Agent",
            pubkey: "a".repeat(64),
            telegram: {
                botToken: "token",
                chatBindings: [{ chatId: "-2001" }],
            },
        };
        const runtimeIngress = {
            handleChatMessage: mock(async ({ envelope }: { envelope: InboundEnvelope }) => {
                expect(envelope.metadata.transport?.telegram).toMatchObject({
                    chatTitle: "Operators",
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

                return event;
            }),
        };
        const gateway = new TelegramGatewayService({
            projectId: "telegram-project",
            projectContext: createProjectContext(agent),
            agentExecutor: {} as any,
            runtimeIngressService: runtimeIngress,
            chatContextService: {
                rememberChatContext: mock(async () => ({
                    projectId: "telegram-project",
                    agentPubkey: agent.pubkey,
                    channelId: "telegram:chat:-2001",
                    chatId: "-2001",
                    chatTitle: "Operators",
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
        });

        await gateway.processUpdate(
            createBinding(agent),
            {
                update_id: 12,
                message: {
                    message_id: 7,
                    date: 125,
                    chat: { id: -2001, type: "supergroup", title: "Operators" },
                    from: {
                        id: 55,
                        is_bot: false,
                        first_name: "Bob",
                    },
                    text: "hello group",
                },
            }
        );

        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(1);
    });

    it("auto-binds first-contact groups and reuses the dynamic binding on follow-up messages", async () => {
        const metadataPath = join(tmpdir(), `telegram-gateway-${Date.now()}-autobind`);
        tempDirs.push(metadataPath);
        mkdirSync(join(metadataPath, "conversations"), { recursive: true });
        ConversationStore.initialize(metadataPath, ["a".repeat(64)]);

        const agent = {
            slug: "telegram-agent",
            name: "Telegram Agent",
            pubkey: "a".repeat(64),
            telegram: {
                botToken: "token",
                chatBindings: [{ chatId: "-9999", title: "Existing Group" }],
            },
        };
        const dynamicBindings = new Map<string, { projectId: string }>();
        const runtimeIngress = {
            handleChatMessage: mock(async ({ envelope }: { envelope: InboundEnvelope }) => {
                const event = new NDKEvent();
                event.id = envelope.message.nativeId;
                event.pubkey = envelope.principal.linkedPubkey ?? "2".repeat(64);
                event.content = envelope.content;
                event.tags = [["p", agent.pubkey]];

                const conversation = ConversationStore.getOrLoad(`conversation-${envelope.message.nativeId}`);
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

                return event;
            }),
        };
        const rememberProjectBinding = mock(async ({
            binding,
            channelId,
            message,
        }: {
            binding: TelegramGatewayBinding;
            channelId: string;
            message: TelegramUpdate["message"];
        }) => {
            dynamicBindings.set(`${binding.agent.pubkey}::${channelId}`, {
                projectId: "telegram-project",
            });
            if (message?.chat.type !== "private") {
                binding.chatBindings = [
                    ...binding.chatBindings,
                    {
                        chatId: String(message?.chat.id),
                        title: message?.chat.title,
                    },
                ];
                binding.config = {
                    ...binding.config,
                    chatBindings: binding.chatBindings,
                };
            }

            return binding;
        });
        const gateway = new TelegramGatewayService({
            projectId: "telegram-project",
            projectContext: createProjectContext(agent),
            agentExecutor: {} as any,
            runtimeIngressService: runtimeIngress,
            chatContextService: {
                rememberChatContext: mock(async () => ({
                    projectId: "telegram-project",
                    agentPubkey: agent.pubkey,
                    channelId: "telegram:chat:-2001",
                    chatId: "-2001",
                    chatTitle: "Operators",
                    administrators: [],
                    seenParticipants: [{
                        userId: "55",
                        displayName: "Bob",
                        lastSeenAt: 126,
                    }],
                    updatedAt: 126,
                })),
            } as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => false,
            } as any,
            channelBindingStore: {
                getBinding: (agentPubkey: string, channelId: string) =>
                    dynamicBindings.get(`${agentPubkey}::${channelId}`),
                rememberBinding: ({
                    agentPubkey,
                    channelId,
                    projectId,
                }: {
                    agentPubkey: string;
                    channelId: string;
                    projectId: string;
                }) => {
                    dynamicBindings.set(`${agentPubkey}::${channelId}`, { projectId });
                },
            } as any,
            bindingPersistenceService: {
                rememberProjectBinding,
            } as any,
        });

        await gateway.processUpdate(
            createBinding(agent),
            {
                update_id: 13,
                message: {
                    message_id: 8,
                    date: 126,
                    chat: { id: -2001, type: "supergroup", title: "Operators" },
                    from: {
                        id: 55,
                        is_bot: false,
                        first_name: "Bob",
                    },
                    text: "hello group",
                },
            }
        );
        await gateway.processUpdate(
            createBinding(agent),
            {
                update_id: 14,
                message: {
                    message_id: 9,
                    date: 127,
                    chat: { id: -2001, type: "supergroup", title: "Operators" },
                    from: {
                        id: 55,
                        is_bot: false,
                        first_name: "Bob",
                    },
                    text: "follow-up",
                },
            }
        );

        expect(rememberProjectBinding).toHaveBeenCalledTimes(1);
        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(2);
    });

    it("opens /model in an authorized DM without touching runtime ingress or channel sessions", async () => {
        const agent = {
            slug: "telegram-agent",
            name: "Telegram Agent",
            pubkey: "a".repeat(64),
            llmConfig: "model-a",
            tools: ["fs_read"],
            telegram: {
                botToken: "token",
                allowDMs: true,
            },
        };
        const runtimeIngress = {
            handleChatMessage: mock(async () => {
                throw new Error("runtime ingress should not run for /model");
            }),
        };
        const getSession = mock(() => undefined);
        const rememberSession = mock(() => undefined);
        const openCommandMenu = spyOn(
            TelegramConfigCommandService.prototype,
            "openCommandMenu"
        ).mockResolvedValue();
        const client = {
            sendMessage: mock(async () => undefined),
        };
        const gateway = new TelegramGatewayService({
            projectId: "telegram-project",
            projectContext: createProjectContext(agent),
            agentExecutor: {} as any,
            runtimeIngressService: runtimeIngress,
            channelSessionStore: {
                getSession,
                rememberSession,
            } as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => true,
            } as any,
            clientFactory: () => client as any,
        });

        await gateway.processUpdate(
            createBinding(agent),
            {
                update_id: 15,
                message: {
                    message_id: 10,
                    date: 128,
                    chat: { id: 1003, type: "private" },
                    from: {
                        id: 42,
                        is_bot: false,
                        first_name: "Alice",
                    },
                    text: "/model",
                },
            },
            {
                id: 101,
                is_bot: true,
                first_name: "test-bot",
                username: "test_bot",
            }
        );

        expect(openCommandMenu).toHaveBeenCalledTimes(1);
        expect(openCommandMenu.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            commandKind: "model",
            currentModel: "model-a",
            currentTools: ["fs_read"],
            principalId: "telegram:user:42",
        }));
        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(0);
        expect(getSession).toHaveBeenCalledTimes(0);
        expect(rememberSession).toHaveBeenCalledTimes(0);
    });

    it("rejects unauthorized /config commands in groups before runtime routing", async () => {
        const agent = {
            slug: "telegram-agent",
            name: "Telegram Agent",
            pubkey: "a".repeat(64),
            llmConfig: "model-a",
            tools: ["fs_read"],
            telegram: {
                botToken: "token",
            },
        };
        const runtimeIngress = {
            handleChatMessage: mock(async () => {
                throw new Error("runtime ingress should not run for unauthorized /config");
            }),
        };
        const getSession = mock(() => undefined);
        const rememberSession = mock(() => undefined);
        const openCommandMenu = spyOn(
            TelegramConfigCommandService.prototype,
            "openCommandMenu"
        ).mockResolvedValue();
        const client = {
            sendMessage: mock(async () => undefined),
        };
        const gateway = new TelegramGatewayService({
            projectId: "telegram-project",
            projectContext: createProjectContext(agent),
            agentExecutor: {} as any,
            runtimeIngressService: runtimeIngress,
            channelSessionStore: {
                getSession,
                rememberSession,
            } as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => false,
            } as any,
            clientFactory: () => client as any,
        });

        await gateway.processUpdate(
            createBinding(agent),
            {
                update_id: 16,
                message: {
                    message_id: 11,
                    date: 129,
                    chat: { id: -2001, type: "supergroup", title: "Operators" },
                    from: {
                        id: 55,
                        is_bot: false,
                        first_name: "Bob",
                    },
                    text: "/config",
                },
            },
            {
                id: 101,
                is_bot: true,
                first_name: "test-bot",
                username: "test_bot",
            }
        );

        expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            chatId: "-2001",
            text: "You are not allowed to change this agent's Telegram config.",
            replyToMessageId: "11",
        }));
        expect(openCommandMenu).toHaveBeenCalledTimes(0);
        expect(runtimeIngress.handleChatMessage).toHaveBeenCalledTimes(0);
        expect(getSession).toHaveBeenCalledTimes(0);
        expect(rememberSession).toHaveBeenCalledTimes(0);
    });

    it("registers Telegram bot commands when the gateway starts polling", async () => {
        const agent = {
            slug: "telegram-agent",
            name: "Telegram Agent",
            pubkey: "a".repeat(64),
            llmConfig: "model-a",
            tools: ["fs_read"],
            telegram: {
                botToken: "token",
                allowDMs: true,
            },
        };
        const client = {
            getMe: mock(async () => ({
                id: 101,
                is_bot: true as const,
                first_name: "test-bot",
                username: "test_bot",
            })),
            setMyCommands: mock(async () => undefined),
        };
        const gateway = new TelegramGatewayService({
            projectId: "telegram-project",
            projectContext: createProjectContext(agent),
            agentExecutor: {} as any,
            clientFactory: () => client as any,
        });
        const gatewayAny = gateway as any;
        const originalSkipBacklog = gatewayAny.skipBacklog;
        const originalCreatePoller = gatewayAny.createPoller;

        gatewayAny.skipBacklog = mock(async () => undefined);
        gatewayAny.createPoller = mock((binding: TelegramGatewayBinding, botIdentity: any) => ({
            binding,
            botIdentity,
            client,
            nextOffset: undefined,
            loopPromise: Promise.resolve(),
        }));

        try {
            await gateway.start();

            expect(client.setMyCommands).toHaveBeenCalledWith({
                commands: TELEGRAM_CONFIG_BOT_COMMANDS,
            });
        } finally {
            gatewayAny.skipBacklog = originalSkipBacklog;
            gatewayAny.createPoller = originalCreatePoller;
            await gateway.stop();
        }
    });
});
