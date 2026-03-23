import { afterEach, describe, expect, it, mock } from "bun:test";
import { TelegramChatContextService } from "@/services/telegram/TelegramChatContextService";
import { TelegramChatContextStore } from "@/services/telegram/TelegramChatContextStoreService";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createGroupMessage(userId: number, overrides: Partial<any> = {}) {
    const {
        chat: chatOverrides,
        from: fromOverrides,
        ...restOverrides
    } = overrides;

    return {
        message_id: 10 + userId,
        date: 123,
        chat: {
            id: -2001,
            type: "supergroup" as const,
            title: "Operators",
            username: "operators_room",
            ...chatOverrides,
        },
        from: {
            id: userId,
            is_bot: false,
            first_name: `User ${userId}`,
            username: `user_${userId}`,
            ...fromOverrides,
        },
        text: `hello from ${userId}`,
        ...restOverrides,
    };
}

describe("TelegramChatContextService", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        mock.restore();

        for (const dir of tempDirs.splice(0)) {
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it("creates chat context from the first group message and enriches it with Telegram API data", async () => {
        const tempDir = join(tmpdir(), `telegram-chat-context-${Date.now()}`);
        tempDirs.push(tempDir);
        mkdirSync(tempDir, { recursive: true });
        const store = new TelegramChatContextStore(join(tempDir, "telegram-chat-contexts.json"));
        const service = new TelegramChatContextService({
            store,
            apiSyncTtlMs: 0,
            now: () => 1_000,
        });

        const context = await service.rememberChatContext({
            projectId: "project-alpha",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:chat:-2001",
            message: createGroupMessage(42),
            client: {
                getChat: mock(async () => ({
                    id: -2001,
                    type: "supergroup",
                    title: "Operators HQ",
                    username: "operators_hq",
                })),
                getChatAdministrators: mock(async () => ([
                    {
                        status: "administrator",
                        user: {
                            id: 7,
                            is_bot: false,
                            first_name: "Ada",
                            username: "ada_admin",
                        },
                        custom_title: "Owner",
                    },
                ])),
                getChatMemberCount: mock(async () => 14),
            },
        });

        expect(context).toMatchObject({
            projectId: "project-alpha",
            channelId: "telegram:chat:-2001",
            chatId: "-2001",
            chatTitle: "Operators HQ",
            chatUsername: "operators_hq",
            memberCount: 14,
            lastApiSyncAt: 1_000,
        });
        expect(context.administrators).toEqual([
            {
                userId: "7",
                displayName: "Ada",
                username: "ada_admin",
                customTitle: "Owner",
            },
        ]);
        expect(context.seenParticipants).toEqual([
            {
                userId: "42",
                displayName: "User 42",
                username: "user_42",
                lastSeenAt: 1_000,
            },
        ]);
        expect(store.listContexts()).toHaveLength(1);
    });

    it("falls back to cached API data when a refresh fails", async () => {
        const tempDir = join(tmpdir(), `telegram-chat-context-${Date.now()}-fallback`);
        tempDirs.push(tempDir);
        mkdirSync(tempDir, { recursive: true });
        const store = new TelegramChatContextStore(join(tempDir, "telegram-chat-contexts.json"));
        store.rememberContext({
            projectId: "project-alpha",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:chat:-2001",
            chatId: "-2001",
            chatTitle: "Cached Operators",
            chatUsername: "cached_ops",
            memberCount: 8,
            administrators: [{
                userId: "7",
                displayName: "Ada",
                username: "ada_admin",
                customTitle: "Owner",
            }],
            seenParticipants: [],
            updatedAt: 500,
            lastApiSyncAt: 500,
        });
        const service = new TelegramChatContextService({
            store,
            apiSyncTtlMs: 0,
            now: () => 2_000,
        });

        const context = await service.rememberChatContext({
            projectId: "project-alpha",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:chat:-2001",
            message: createGroupMessage(55, {
                chat: {
                    title: "Current Operators",
                },
            }),
            client: {
                getChat: mock(async () => {
                    throw new Error("chat lookup failed");
                }),
                getChatAdministrators: mock(async () => {
                    throw new Error("admins lookup failed");
                }),
                getChatMemberCount: mock(async () => {
                    throw new Error("member count lookup failed");
                }),
            },
        });

        expect(context.chatTitle).toBe("Current Operators");
        expect(context.chatUsername).toBe("cached_ops");
        expect(context.memberCount).toBe(8);
        expect(context.administrators).toHaveLength(1);
        expect(context.seenParticipants[0]).toMatchObject({
            userId: "55",
            displayName: "User 55",
        });
    });

    it("honors the API refresh TTL", async () => {
        const tempDir = join(tmpdir(), `telegram-chat-context-${Date.now()}-ttl`);
        tempDirs.push(tempDir);
        mkdirSync(tempDir, { recursive: true });
        const store = new TelegramChatContextStore(join(tempDir, "telegram-chat-contexts.json"));
        let now = 1_000;
        const getChat = mock(async () => ({
            id: -2001,
            type: "supergroup",
            title: "Operators",
        }));
        const getChatAdministrators = mock(async () => []);
        const getChatMemberCount = mock(async () => 10);
        const service = new TelegramChatContextService({
            store,
            apiSyncTtlMs: 5_000,
            now: () => now,
        });

        await service.rememberChatContext({
            projectId: "project-alpha",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:chat:-2001",
            message: createGroupMessage(42),
            client: {
                getChat,
                getChatAdministrators,
                getChatMemberCount,
            },
        });

        now = 2_000;
        await service.rememberChatContext({
            projectId: "project-alpha",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:chat:-2001",
            message: createGroupMessage(43),
            client: {
                getChat,
                getChatAdministrators,
                getChatMemberCount,
            },
        });

        expect(getChat).toHaveBeenCalledTimes(1);
        expect(getChatAdministrators).toHaveBeenCalledTimes(1);
        expect(getChatMemberCount).toHaveBeenCalledTimes(1);
    });

    it("deduplicates and caps seen participants", async () => {
        const tempDir = join(tmpdir(), `telegram-chat-context-${Date.now()}-participants`);
        tempDirs.push(tempDir);
        mkdirSync(tempDir, { recursive: true });
        const store = new TelegramChatContextStore(join(tempDir, "telegram-chat-contexts.json"));
        let now = 1_000;
        const service = new TelegramChatContextService({
            store,
            apiSyncTtlMs: 60_000,
            now: () => now,
        });

        const client = {
            getChat: mock(async () => ({
                id: -2001,
                type: "supergroup",
                title: "Operators",
            })),
            getChatAdministrators: mock(async () => []),
            getChatMemberCount: mock(async () => 99),
        };

        for (let index = 0; index < 30; index++) {
            now += 1;
            await service.rememberChatContext({
                projectId: "project-alpha",
                agentPubkey: "a".repeat(64),
                channelId: "telegram:chat:-2001",
                message: createGroupMessage(index + 1),
                client,
            });
        }

        now += 1;
        const finalContext = await service.rememberChatContext({
            projectId: "project-alpha",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:chat:-2001",
            message: createGroupMessage(5, {
                from: {
                    first_name: "Updated Five",
                    username: "five_again",
                },
            }),
            client,
        });

        expect(finalContext.seenParticipants).toHaveLength(25);
        expect(finalContext.seenParticipants[0]).toEqual({
            userId: "5",
            displayName: "Updated Five",
            username: "five_again",
            lastSeenAt: now,
        });
        expect(finalContext.seenParticipants.some((participant) => participant.userId === "1")).toBe(false);
    });
});
