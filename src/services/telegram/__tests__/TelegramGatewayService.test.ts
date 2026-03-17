import { afterEach, describe, expect, it, mock } from "bun:test";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { ChannelSessionStore } from "@/services/ingress/ChannelSessionStoreService";
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
});
