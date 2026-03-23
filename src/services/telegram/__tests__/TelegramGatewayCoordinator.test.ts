import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { projectContextStore } from "@/services/projects";
import type { TelegramBindingPersistenceService } from "@/services/telegram/TelegramBindingPersistenceService";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import {
    TELEGRAM_CONFIG_BOT_COMMANDS,
    TelegramConfigCommandService,
} from "@/services/telegram/TelegramConfigCommandService";
import { TelegramGatewayCoordinator } from "@/services/telegram/TelegramGatewayCoordinator";

function createRegistration(projectId: string, projectTitle: string) {
    const agent = {
        name: "Telegram Agent",
        slug: "telegram-agent",
        pubkey: "a".repeat(64),
        llmConfig: "model-a",
        tools: ["fs_read"],
        telegram: {
            botToken: "shared-token",
            apiBaseUrl: "https://telegram.example",
            allowDMs: true,
            chatBindings: [],
        },
    };
    const projectContext = {
        agentRegistry: {
            reloadAgent: async () => true,
        },
        getAgentByPubkey: () => agent,
    } as any;

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
            chatBindings: agent.telegram.chatBindings ?? [],
        },
    };
}

function createGroupUpdate(updateId: number, text: string) {
    return {
        update_id: updateId,
        message: {
            message_id: updateId + 20,
            date: 123,
            chat: {
                id: -2001,
                type: "supergroup" as const,
                title: "Operators",
            },
            from: {
                id: 42,
                is_bot: false as const,
                first_name: "Alice",
            },
            text,
        },
    };
}

describe("TelegramGatewayCoordinator", () => {
    afterEach(() => {
        TelegramGatewayCoordinator.resetInstance();
        mock.restore();
    });

    it("registers a poller before starting the poll loop", async () => {
        const coordinator = TelegramGatewayCoordinator.getInstance() as any;
        let sawRegisteredPoller = false;
        const originalGetMe = TelegramBotClient.prototype.getMe;
        const originalSetMyCommands = TelegramBotClient.prototype.setMyCommands;
        const originalSkipBacklog = coordinator.skipBacklog;
        const originalRunPollLoop = coordinator.runPollLoop;
        const setMyCommands = mock(async () => undefined);

        TelegramBotClient.prototype.getMe = async () => ({
            id: 101,
            is_bot: true as const,
            first_name: "test-bot",
            username: "test_bot",
        });
        TelegramBotClient.prototype.setMyCommands = setMyCommands;
        coordinator.skipBacklog = async () => undefined;
        coordinator.runPollLoop = async (poller: { token: string }) => {
            sawRegisteredPoller = coordinator.pollers.has(poller.token);
        };

        try {
            await coordinator.startPoller("shared-token", createRegistration("project-alpha", "Project Alpha"));

            expect(sawRegisteredPoller).toBe(true);
            expect(coordinator.pollers.has("shared-token")).toBe(true);
            expect(setMyCommands).toHaveBeenCalledWith({
                commands: TELEGRAM_CONFIG_BOT_COMMANDS,
            });
        } finally {
            TelegramBotClient.prototype.getMe = originalGetMe;
            TelegramBotClient.prototype.setMyCommands = originalSetMyCommands;
            coordinator.skipBacklog = originalSkipBacklog;
            coordinator.runPollLoop = originalRunPollLoop;
        }
    });

    it("auto-binds a first-contact group when there is a single project candidate", async () => {
        const coordinator = TelegramGatewayCoordinator.getInstance() as any;
        const registration = createRegistration("project-alpha", "Project Alpha");
        const rememberProjectBinding = mock(async ({ binding }: { binding: typeof registration.binding }) => binding);
        const routeUpdateToRegistration = mock(async () => undefined);

        coordinator.registrations.set("shared-token", [registration]);
        coordinator.pendingBindingStore = {
            getPending: () => undefined,
            rememberPending: mock(() => undefined),
            clearPending: mock(() => undefined),
        };
        coordinator.channelSessionStore = {
            findSessionByAgentChannel: () => undefined,
        };
        coordinator.channelBindingStore = {
            getBinding: () => undefined,
        };
        coordinator.authorizedIdentityService = {
            isAuthorizedPrincipal: () => true,
        };
        coordinator.bindingPersistenceService = {
            rememberProjectBinding,
        } satisfies Pick<TelegramBindingPersistenceService, "rememberProjectBinding">;
        coordinator.routeUpdateToRegistration = routeUpdateToRegistration;

        await coordinator.processUpdate({
            token: "shared-token",
            agentPubkey: registration.binding.agent.pubkey,
            client: {
                sendMessage: mock(async () => undefined),
            },
            botIdentity: {
                id: 101,
                is_bot: true,
                first_name: "test-bot",
            },
            loopPromise: Promise.resolve(),
        }, createGroupUpdate(1, "hello group"));

        expect(rememberProjectBinding).toHaveBeenCalledTimes(1);
        expect(routeUpdateToRegistration).toHaveBeenCalledTimes(1);
        expect(coordinator.pendingBindingStore.rememberPending).toHaveBeenCalledTimes(0);
    });

    it("prompts for shared-bot ambiguity and persists the selected project after the numeric reply", async () => {
        const coordinator = TelegramGatewayCoordinator.getInstance() as any;
        const alpha = createRegistration("project-alpha", "Project Alpha");
        const beta = createRegistration("project-beta", "Project Beta");
        const rememberProjectBinding = mock(async ({ binding }: { binding: typeof alpha.binding }) => binding);
        const pendingStore = new Map<string, {
            agentPubkey: string;
            channelId: string;
            projects: Array<{ projectId: string; title: string }>;
            requestedAt: number;
        }>();
        const sentMessages: string[] = [];

        coordinator.registrations.set("shared-token", [alpha, beta]);
        coordinator.pendingBindingStore = {
            getPending: (agentPubkey: string, channelId: string) =>
                pendingStore.get(`${agentPubkey}::${channelId}`),
            rememberPending: mock((record: {
                agentPubkey: string;
                channelId: string;
                projects: Array<{ projectId: string; title: string }>;
                requestedAt: number;
            }) => {
                pendingStore.set(`${record.agentPubkey}::${record.channelId}`, record);
                return record;
            }),
            clearPending: mock((agentPubkey: string, channelId: string) => {
                pendingStore.delete(`${agentPubkey}::${channelId}`);
            }),
        };
        coordinator.channelSessionStore = {
            findSessionByAgentChannel: () => undefined,
        };
        coordinator.channelBindingStore = {
            getBinding: () => undefined,
        };
        coordinator.authorizedIdentityService = {
            isAuthorizedPrincipal: () => true,
        };
        coordinator.bindingPersistenceService = {
            rememberProjectBinding,
        } satisfies Pick<TelegramBindingPersistenceService, "rememberProjectBinding">;
        coordinator.routeUpdateToRegistration = mock(async () => undefined);

        const poller = {
            token: "shared-token",
            agentPubkey: alpha.binding.agent.pubkey,
            client: {
                sendMessage: mock(async ({ text }: { text: string }) => {
                    sentMessages.push(text);
                    return undefined;
                }),
            },
            botIdentity: {
                id: 101,
                is_bot: true,
                first_name: "test-bot",
            },
            loopPromise: Promise.resolve(),
        };

        await coordinator.processUpdate(poller, createGroupUpdate(1, "hello group"));

        expect(sentMessages[0]).toContain("Reply with one of these numbers:");
        expect(coordinator.pendingBindingStore.rememberPending).toHaveBeenCalledTimes(1);
        expect(rememberProjectBinding).toHaveBeenCalledTimes(0);

        await coordinator.processUpdate(poller, createGroupUpdate(2, "2"));

        expect(rememberProjectBinding).toHaveBeenCalledTimes(1);
        expect(rememberProjectBinding.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                projectId: "project-beta",
                channelId: "telegram:chat:-2001",
            })
        );
        expect(sentMessages[1]).toContain('Bound this chat to project "Project Beta"');
        expect(coordinator.pendingBindingStore.clearPending).toHaveBeenCalledTimes(1);
    });

    it("requires project selection before opening a shared-bot config menu and does not auto-resume after binding", async () => {
        const coordinator = TelegramGatewayCoordinator.getInstance() as any;
        const alpha = createRegistration("project-alpha", "Project Alpha");
        const beta = createRegistration("project-beta", "Project Beta");
        const rememberProjectBinding = mock(async ({ binding }: { binding: typeof alpha.binding }) => binding);
        const pendingStore = new Map<string, {
            agentPubkey: string;
            channelId: string;
            projects: Array<{ projectId: string; title: string }>;
            requestedAt: number;
        }>();
        const sentMessages: string[] = [];
        const openCommandMenu = spyOn(
            TelegramConfigCommandService.prototype,
            "openCommandMenu"
        ).mockResolvedValue();
        const routeUpdateToRegistration = mock(async () => undefined);

        coordinator.registrations.set("shared-token", [alpha, beta]);
        coordinator.pendingBindingStore = {
            getPending: (agentPubkey: string, channelId: string) =>
                pendingStore.get(`${agentPubkey}::${channelId}`),
            rememberPending: mock((record: {
                agentPubkey: string;
                channelId: string;
                projects: Array<{ projectId: string; title: string }>;
                requestedAt: number;
            }) => {
                pendingStore.set(`${record.agentPubkey}::${record.channelId}`, record);
                return record;
            }),
            clearPending: mock((agentPubkey: string, channelId: string) => {
                pendingStore.delete(`${agentPubkey}::${channelId}`);
            }),
        };
        coordinator.channelSessionStore = {
            findSessionByAgentChannel: () => undefined,
        };
        coordinator.channelBindingStore = {
            getBinding: () => undefined,
        };
        coordinator.authorizedIdentityService = {
            isAuthorizedPrincipal: () => true,
        };
        coordinator.bindingPersistenceService = {
            rememberProjectBinding,
        } satisfies Pick<TelegramBindingPersistenceService, "rememberProjectBinding">;
        coordinator.routeUpdateToRegistration = routeUpdateToRegistration;

        const poller = {
            token: "shared-token",
            agentPubkey: alpha.binding.agent.pubkey,
            client: {
                sendMessage: mock(async ({ text }: { text: string }) => {
                    sentMessages.push(text);
                    return undefined;
                }),
            },
            botIdentity: {
                id: 101,
                is_bot: true,
                first_name: "test-bot",
                username: "test_bot",
            },
            loopPromise: Promise.resolve(),
        };

        await coordinator.processUpdate(poller, createGroupUpdate(1, "/model"));

        expect(sentMessages[0]).toContain("Reply with one of these numbers:");
        expect(coordinator.pendingBindingStore.rememberPending).toHaveBeenCalledTimes(1);
        expect(openCommandMenu).toHaveBeenCalledTimes(0);
        expect(routeUpdateToRegistration).toHaveBeenCalledTimes(0);

        await coordinator.processUpdate(poller, createGroupUpdate(2, "2"));

        expect(rememberProjectBinding).toHaveBeenCalledTimes(1);
        expect(sentMessages[1]).toContain('Bound this chat to project "Project Beta"');
        expect(openCommandMenu).toHaveBeenCalledTimes(0);
        expect(routeUpdateToRegistration).toHaveBeenCalledTimes(0);
        expect(coordinator.pendingBindingStore.clearPending).toHaveBeenCalledTimes(1);
    });
});
