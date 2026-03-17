import { afterEach, describe, expect, it } from "bun:test";
import { TelegramBotClient } from "@/services/telegram/TelegramBotClient";
import { TelegramGatewayCoordinator } from "@/services/telegram/TelegramGatewayCoordinator";

describe("TelegramGatewayCoordinator", () => {
    afterEach(() => {
        TelegramGatewayCoordinator.resetInstance();
    });

    it("registers a poller before starting the poll loop", async () => {
        const coordinator = TelegramGatewayCoordinator.getInstance() as any;
        let sawRegisteredPoller = false;
        const originalGetMe = TelegramBotClient.prototype.getMe;
        const originalSkipBacklog = coordinator.skipBacklog;
        const originalRunPollLoop = coordinator.runPollLoop;

        TelegramBotClient.prototype.getMe = async () => ({
            id: 101,
            is_bot: true as const,
            first_name: "test-bot",
            username: "test_bot",
        });
        coordinator.skipBacklog = async () => undefined;
        coordinator.runPollLoop = async (poller: { token: string }) => {
            sawRegisteredPoller = coordinator.pollers.has(poller.token);
        };

        try {
            await coordinator.startPoller("shared-token", {
                projectId: "project-alpha",
                projectTitle: "Project Alpha",
                projectContext: {} as any,
                agentExecutor: {} as any,
                binding: {
                    agent: {
                        pubkey: "a".repeat(64),
                        slug: "telegram-agent",
                    },
                    config: {
                        botToken: "shared-token",
                        apiBaseUrl: "https://telegram.example",
                    },
                    chatBindings: [],
                },
            });

            expect(sawRegisteredPoller).toBe(true);
            expect(coordinator.pollers.has("shared-token")).toBe(true);
        } finally {
            TelegramBotClient.prototype.getMe = originalGetMe;
            coordinator.skipBacklog = originalSkipBacklog;
            coordinator.runPollLoop = originalRunPollLoop;
        }
    });
});
