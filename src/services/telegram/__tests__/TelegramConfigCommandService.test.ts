import { afterEach, describe, expect, it, mock } from "bun:test";
import { TelegramConfigCommandService } from "@/services/telegram/TelegramConfigCommandService";
import { TelegramConfigSessionStore } from "@/services/telegram/TelegramConfigSessionStoreService";
import type { TelegramGatewayBinding, TelegramMessage, TelegramUpdate } from "@/services/telegram/types";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createBinding(): TelegramGatewayBinding {
    return {
        agent: {
            name: "Telegram Agent",
            slug: "telegram-agent",
            pubkey: "a".repeat(64),
            llmConfig: "model-a",
            tools: ["fs_read"],
            telegram: {
                botToken: "token",
                allowDMs: true,
            },
        } as any,
        config: {
            botToken: "token",
            allowDMs: true,
        },
    };
}

function createMessage(
    overrides: Partial<TelegramMessage> = {}
): TelegramMessage {
    return {
        message_id: 10,
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
        text: "/config",
        ...overrides,
    };
}

function createCallbackUpdate(data: string, fromId = 42): TelegramUpdate {
    return {
        update_id: 1,
        callback_query: {
            id: "callback-1",
            data,
            from: {
                id: fromId,
                is_bot: false,
                first_name: "Alice",
            },
            message: createMessage(),
        },
    };
}

describe("TelegramConfigCommandService", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        mock.restore();

        for (const dir of tempDirs.splice(0)) {
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it("opens a /config tool picker seeded from the agent's current effective tools", async () => {
        const baseDir = join(tmpdir(), `telegram-config-command-${Date.now()}`);
        const storagePath = join(baseDir, "telegram-config-sessions.json");
        tempDirs.push(baseDir);
        mkdirSync(baseDir, { recursive: true });

        const sessionStore = new TelegramConfigSessionStore(storagePath);
        const sendMessage = mock(async () => ({
            message_id: 200,
            date: 123,
            chat: { id: 1001, type: "private" as const },
        }));
        const service = new TelegramConfigCommandService({
            configOptionsService: {
                getProjectOptions: mock(async () => ({
                    models: ["model-a", "model-b"],
                    tools: ["fs_read", "shell"],
                })),
            } as any,
            configPublisher: {
                publishProjectScopedUpdate: mock(async () => ({})),
            } as any,
            sessionStore,
        });

        await service.openCommandMenu({
            binding: createBinding(),
            client: {
                sendMessage,
            } as any,
            commandKind: "tools",
            currentModel: "model-a",
            currentTools: ["fs_read", "delegate"],
            message: createMessage(),
            principalId: "telegram:user:42",
            projectBinding: `31933:${"f".repeat(64)}:project-alpha`,
            projectContext: {
                agentRegistry: {},
                mcpManager: undefined,
            } as any,
            projectId: "project-alpha",
            projectTitle: "Project Alpha",
        });

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
            chatId: "1001",
            text: expect.stringContaining("Tool picker for Telegram Agent"),
            replyMarkup: {
                inline_keyboard: [
                    [{ text: "[x] fs_read", callback_data: expect.stringContaining(":tt:0") }],
                    [{ text: "[ ] shell", callback_data: expect.stringContaining(":tt:1") }],
                    [
                        { text: "Save", callback_data: expect.stringContaining(":save") },
                        { text: "Cancel", callback_data: expect.stringContaining(":cancel") },
                    ],
                ],
            },
        });

        const [persistedSession] = JSON.parse(readFileSync(storagePath, "utf8")) as Array<{
            id: string;
        }>;
        expect(persistedSession?.id).toBeDefined();
        const session = sessionStore.getSession(String(persistedSession?.id));
        expect(session).toMatchObject({
            channelId: "telegram:chat:1001",
            messageId: "200",
            selectedModel: "model-a",
            selectedTools: ["fs_read"],
        });
    });

    it("publishes a full project-scoped snapshot when a /model selection is applied", async () => {
        const baseDir = join(tmpdir(), `telegram-config-command-model-${Date.now()}`);
        const storagePath = join(baseDir, "telegram-config-sessions.json");
        tempDirs.push(baseDir);
        mkdirSync(baseDir, { recursive: true });

        const sessionStore = new TelegramConfigSessionStore(storagePath);
        const publishProjectScopedUpdate = mock(async () => ({}));
        const answerCallbackQuery = mock(async () => undefined);
        const editMessageText = mock(async () => ({
            message_id: 200,
            date: 123,
            chat: { id: 1001, type: "private" as const },
        }));
        const service = new TelegramConfigCommandService({
            configOptionsService: {
                getProjectOptions: mock(async () => ({
                    models: ["model-a", "model-b"],
                    tools: ["fs_read", "shell"],
                })),
            } as any,
            configPublisher: {
                publishProjectScopedUpdate,
            } as any,
            sessionStore,
        });
        const session = sessionStore.createSession({
            agentName: "Telegram Agent",
            agentPubkey: "a".repeat(64),
            availableModels: ["model-a", "model-b"],
            availableTools: ["fs_read", "shell"],
            channelId: "telegram:chat:1001",
            chatId: "1001",
            currentPage: 0,
            kind: "model",
            messageId: "200",
            principalId: "telegram:user:42",
            projectBinding: `31933:${"f".repeat(64)}:project-alpha`,
            projectId: "project-alpha",
            projectTitle: "Project Alpha",
            selectedModel: "model-a",
            selectedTools: ["fs_read", "shell"],
        });
        const update = createCallbackUpdate(`tgcfg:${session.id}:sm:1`);
        const callbackContext = service.getCallbackContext(update);

        expect(callbackContext).not.toBeNull();
        await service.handleCallback({
            callbackContext: callbackContext!,
            client: {
                answerCallbackQuery,
                editMessageText,
            } as any,
            update,
        });

        expect(publishProjectScopedUpdate).toHaveBeenCalledWith({
            projectBinding: `31933:${"f".repeat(64)}:project-alpha`,
            agentPubkey: "a".repeat(64),
            model: "model-b",
            tools: ["fs_read", "shell"],
            clientTag: "tenex-telegram",
        });
        expect(answerCallbackQuery).toHaveBeenCalledWith({
            callbackQueryId: "callback-1",
            text: "Applied model: model-b",
        });
        expect(editMessageText).toHaveBeenCalledWith({
            chatId: "1001",
            messageId: "200",
            text: "Updated Telegram Agent.\nModel: model-b\nTools: fs_read, shell",
        });
        expect(sessionStore.getSession(session.id)).toBeUndefined();
    });

    it("publishes the selected tool set when a /config menu is saved", async () => {
        const baseDir = join(tmpdir(), `telegram-config-command-tools-${Date.now()}`);
        const storagePath = join(baseDir, "telegram-config-sessions.json");
        tempDirs.push(baseDir);
        mkdirSync(baseDir, { recursive: true });

        const sessionStore = new TelegramConfigSessionStore(storagePath);
        const publishProjectScopedUpdate = mock(async () => ({}));
        const answerCallbackQuery = mock(async () => undefined);
        const editMessageText = mock(async () => ({
            message_id: 201,
            date: 123,
            chat: { id: 1001, type: "private" as const },
        }));
        const service = new TelegramConfigCommandService({
            configOptionsService: {
                getProjectOptions: mock(async () => ({
                    models: ["model-a", "model-b"],
                    tools: ["fs_read", "shell"],
                })),
            } as any,
            configPublisher: {
                publishProjectScopedUpdate,
            } as any,
            sessionStore,
        });
        const session = sessionStore.createSession({
            agentName: "Telegram Agent",
            agentPubkey: "a".repeat(64),
            availableModels: ["model-a", "model-b"],
            availableTools: ["fs_read", "shell"],
            channelId: "telegram:chat:1001",
            chatId: "1001",
            currentPage: 0,
            kind: "tools",
            messageId: "201",
            principalId: "telegram:user:42",
            projectBinding: `31933:${"f".repeat(64)}:project-alpha`,
            projectId: "project-alpha",
            projectTitle: "Project Alpha",
            selectedModel: "model-a",
            selectedTools: ["fs_read"],
        });

        const toggleUpdate = createCallbackUpdate(`tgcfg:${session.id}:tt:1`);
        await service.handleCallback({
            callbackContext: service.getCallbackContext(toggleUpdate)!,
            client: {
                answerCallbackQuery,
                editMessageText,
            } as any,
            update: toggleUpdate,
        });

        const toggledSession = sessionStore.getSession(session.id);
        expect(toggledSession?.selectedTools).toEqual(["fs_read", "shell"]);

        const saveUpdate = createCallbackUpdate(`tgcfg:${session.id}:save`);
        await service.handleCallback({
            callbackContext: service.getCallbackContext(saveUpdate)!,
            client: {
                answerCallbackQuery,
                editMessageText,
            } as any,
            update: saveUpdate,
        });

        expect(publishProjectScopedUpdate).toHaveBeenCalledWith({
            projectBinding: `31933:${"f".repeat(64)}:project-alpha`,
            agentPubkey: "a".repeat(64),
            model: "model-a",
            tools: ["fs_read", "shell"],
            clientTag: "tenex-telegram",
        });
        expect(sessionStore.getSession(session.id)).toBeUndefined();
    });

    it("rejects callback presses from a different Telegram user", async () => {
        const baseDir = join(tmpdir(), `telegram-config-command-owner-${Date.now()}`);
        const storagePath = join(baseDir, "telegram-config-sessions.json");
        tempDirs.push(baseDir);
        mkdirSync(baseDir, { recursive: true });

        const sessionStore = new TelegramConfigSessionStore(storagePath);
        const publishProjectScopedUpdate = mock(async () => ({}));
        const answerCallbackQuery = mock(async () => undefined);
        const editMessageText = mock(async () => ({
            message_id: 202,
            date: 123,
            chat: { id: 1001, type: "private" as const },
        }));
        const service = new TelegramConfigCommandService({
            configPublisher: {
                publishProjectScopedUpdate,
            } as any,
            sessionStore,
        });
        const session = sessionStore.createSession({
            agentName: "Telegram Agent",
            agentPubkey: "a".repeat(64),
            availableModels: ["model-a", "model-b"],
            availableTools: ["fs_read", "shell"],
            channelId: "telegram:chat:1001",
            chatId: "1001",
            currentPage: 0,
            kind: "model",
            messageId: "202",
            principalId: "telegram:user:42",
            projectBinding: `31933:${"f".repeat(64)}:project-alpha`,
            projectId: "project-alpha",
            projectTitle: "Project Alpha",
            selectedModel: "model-a",
            selectedTools: ["fs_read"],
        });
        const update = createCallbackUpdate(`tgcfg:${session.id}:sm:1`, 99);

        await service.handleCallback({
            callbackContext: service.getCallbackContext(update)!,
            client: {
                answerCallbackQuery,
                editMessageText,
            } as any,
            update,
        });

        expect(answerCallbackQuery).toHaveBeenCalledWith({
            callbackQueryId: "callback-1",
            showAlert: true,
            text: "Only the user who opened this menu can use it.",
        });
        expect(editMessageText).toHaveBeenCalledTimes(0);
        expect(publishProjectScopedUpdate).toHaveBeenCalledTimes(0);
        expect(sessionStore.getSession(session.id)).toBeDefined();
    });

    it("rejects expired or missing config sessions", async () => {
        const baseDir = join(tmpdir(), `telegram-config-command-expired-${Date.now()}`);
        const storagePath = join(baseDir, "telegram-config-sessions.json");
        tempDirs.push(baseDir);
        mkdirSync(baseDir, { recursive: true });

        const answerCallbackQuery = mock(async () => undefined);
        const publishProjectScopedUpdate = mock(async () => ({}));
        const service = new TelegramConfigCommandService({
            configPublisher: {
                publishProjectScopedUpdate,
            } as any,
            sessionStore: new TelegramConfigSessionStore(storagePath),
        });
        const update = createCallbackUpdate("tgcfg:missing:save");

        await service.handleCallback({
            callbackContext: service.getCallbackContext(update)!,
            client: {
                answerCallbackQuery,
            } as any,
            update,
        });

        expect(answerCallbackQuery).toHaveBeenCalledWith({
            callbackQueryId: "callback-1",
            showAlert: true,
            text: "This config menu expired. Run the command again.",
        });
        expect(publishProjectScopedUpdate).toHaveBeenCalledTimes(0);
    });
});
