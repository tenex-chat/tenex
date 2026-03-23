import { describe, expect, it, mock } from "bun:test";
import { TelegramBindingPersistenceService } from "@/services/telegram/TelegramBindingPersistenceService";
import type { TelegramGatewayBinding, TelegramMessage } from "@/services/telegram/types";

function createBinding(chatBindings: Array<{ chatId: string; topicId?: string; title?: string }> = []): TelegramGatewayBinding {
    return {
        agent: {
            name: "Telegram Agent",
            slug: "telegram-agent",
            pubkey: "a".repeat(64),
            telegram: {
                botToken: "token",
                allowDMs: true,
                chatBindings,
            },
        },
        config: {
            botToken: "token",
            allowDMs: true,
            chatBindings,
        },
        chatBindings,
    };
}

function createGroupMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
    return {
        message_id: 10,
        date: 123,
        chat: {
            id: -2001,
            type: "supergroup",
            title: "Operators",
        },
        from: {
            id: 42,
            is_bot: false,
            first_name: "Alice",
        },
        text: "hello group",
        ...overrides,
    };
}

describe("TelegramBindingPersistenceService", () => {
    it("persists a new topic binding into the project Telegram override", async () => {
        const rememberBinding = mock(() => undefined);
        const updateProjectTelegramConfig = mock(async () => true);
        const service = new TelegramBindingPersistenceService({
            channelBindingStore: {
                rememberBinding,
            } as any,
            agentStorage: {
                loadAgent: mock(async () => ({ slug: "telegram-agent" })),
                getEffectiveConfig: mock(() => ({
                    telegram: {
                        botToken: "token",
                        allowDMs: true,
                    },
                })),
                updateProjectTelegramConfig,
            } as any,
        });

        const binding = createBinding();
        await service.rememberProjectBinding({
            projectId: "project-alpha",
            binding,
            channelId: "telegram:group:-2001:topic:55",
            message: createGroupMessage({
                message_thread_id: 55,
            }),
        });

        expect(rememberBinding).toHaveBeenCalledWith({
            agentPubkey: "a".repeat(64),
            channelId: "telegram:group:-2001:topic:55",
            projectId: "project-alpha",
        });
        expect(updateProjectTelegramConfig).toHaveBeenCalledWith(
            "a".repeat(64),
            "project-alpha",
            expect.objectContaining({
                chatBindings: [
                    {
                        chatId: "-2001",
                        topicId: "55",
                        title: "Operators",
                    },
                ],
            })
        );
    });

    it("upserts by chat and topic without duplicating entries and preserves an existing title", async () => {
        const updateProjectTelegramConfig = mock(async () => true);
        const service = new TelegramBindingPersistenceService({
            channelBindingStore: {
                rememberBinding: mock(() => undefined),
            } as any,
            agentStorage: {
                loadAgent: mock(async () => ({ slug: "telegram-agent" })),
                getEffectiveConfig: mock(() => ({
                    telegram: {
                        botToken: "token",
                        allowDMs: true,
                        chatBindings: [
                            {
                                chatId: "-2001",
                                title: "Existing Title",
                            },
                            {
                                chatId: "-2001",
                                title: "Duplicate Title",
                            },
                        ],
                    },
                })),
                updateProjectTelegramConfig,
            } as any,
        });

        const binding = createBinding([
            {
                chatId: "-2001",
                title: "Existing Title",
            },
        ]);
        await service.rememberProjectBinding({
            projectId: "project-alpha",
            binding,
            channelId: "telegram:chat:-2001",
            message: createGroupMessage({
                chat: {
                    id: -2001,
                    type: "supergroup",
                    title: "New Title",
                },
            }),
        });

        expect(updateProjectTelegramConfig).toHaveBeenCalledWith(
            "a".repeat(64),
            "project-alpha",
            expect.objectContaining({
                chatBindings: [
                    {
                        chatId: "-2001",
                        title: "Existing Title",
                    },
                ],
            })
        );
        expect(binding.chatBindings).toEqual([
            {
                chatId: "-2001",
                title: "Existing Title",
            },
        ]);
    });
});
