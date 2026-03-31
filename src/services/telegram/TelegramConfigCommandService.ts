import { AgentConfigPublisher } from "@/nostr/AgentConfigPublisher";
import type { ProjectContext } from "@/services/projects";
import {
    getTelegramConfigSessionStore,
    type TelegramConfigSessionKind,
    type TelegramConfigSessionRecord,
    type TelegramConfigSessionStore,
} from "@/services/telegram/TelegramConfigSessionStoreService";
import { createTelegramChannelId } from "@/utils/telegram-identifiers";
import { ProjectConfigOptionsService } from "@/services/status/ProjectConfigOptionsService";
import type {
    TelegramBotClient,
} from "@/services/telegram/TelegramBotClient";
import type {
    TelegramBotCommand,
    TelegramGatewayBinding,
    TelegramInlineKeyboardButton,
    TelegramInlineKeyboardMarkup,
    TelegramMessage,
    TelegramUpdate,
} from "@/services/telegram/types";

const CALLBACK_PREFIX = "tgcfg";
const PAGE_SIZE = 6;

export const TELEGRAM_NEW_CONVERSATION_SUCCESS_MESSAGE =
    "Started a new conversation. Send your next message to begin fresh.";
export const TELEGRAM_NEW_CONVERSATION_USAGE_MESSAGE =
    "Telegram `/new` does not take arguments yet. Send `/new`, then your next message.";

export const TELEGRAM_BOT_COMMANDS: TelegramBotCommand[] = [
    {
        command: "model",
        description: "Change the agent model",
    },
    {
        command: "config",
        description: "Change the agent tools",
    },
    {
        command: "new",
        description: "Start a fresh conversation",
    },
];

type ConfigAction =
    | { type: "cancel" }
    | { type: "next" }
    | { type: "previous" }
    | { index: number; type: "select-model" }
    | { index: number; type: "toggle-tool" }
    | { type: "save" };

export type TelegramGatewayCommand =
    | { type: "config"; kind: TelegramConfigSessionKind }
    | { type: "new" };

export interface TelegramConfigCommandContext {
    action: ConfigAction;
    session?: TelegramConfigSessionRecord;
}

function normalizeCommandToken(
    commandText: string,
    botUsername?: string
): string | undefined {
    const trimmed = commandText.trim();
    if (!trimmed.startsWith("/")) {
        return undefined;
    }

    const [command] = trimmed.split(/\s+/, 1);
    if (!command) {
        return undefined;
    }

    const [name, username] = command.slice(1).split("@", 2);
    if (!name) {
        return undefined;
    }

    if (
        username &&
        botUsername &&
        username.toLowerCase() !== botUsername.toLowerCase()
    ) {
        return undefined;
    }

    return name.toLowerCase();
}

function toCommandKind(
    commandText: string,
    botUsername?: string
): TelegramConfigSessionKind | undefined {
    const token = normalizeCommandToken(commandText, botUsername);
    if (token === "model") {
        return "model";
    }
    if (token === "config") {
        return "tools";
    }
    return undefined;
}

function toGatewayCommand(
    commandText: string,
    botUsername?: string
): TelegramGatewayCommand | undefined {
    const configKind = toCommandKind(commandText, botUsername);
    if (configKind) {
        return {
            type: "config",
            kind: configKind,
        };
    }

    const token = normalizeCommandToken(commandText, botUsername);
    if (token === "new") {
        return { type: "new" };
    }

    return undefined;
}

function toCommandUsage(command: TelegramGatewayCommand): string {
    if (command.type === "new") {
        return TELEGRAM_NEW_CONVERSATION_USAGE_MESSAGE;
    }

    return command.kind === "model"
        ? "Telegram `/model` does not take arguments yet. Use the buttons in the picker."
        : "Telegram `/config` does not take arguments yet. Use the buttons in the picker.";
}

function parseCallbackData(data: string | undefined): ConfigAction | undefined {
    if (!data) {
        return undefined;
    }

    const [, , action, rawIndex] = data.split(":");
    switch (action) {
        case "cancel":
            return { type: "cancel" };
        case "next":
            return { type: "next" };
        case "prev":
            return { type: "previous" };
        case "save":
            return { type: "save" };
        case "sm": {
            const index = Number(rawIndex);
            return Number.isInteger(index) ? { type: "select-model", index } : undefined;
        }
        case "tt": {
            const index = Number(rawIndex);
            return Number.isInteger(index) ? { type: "toggle-tool", index } : undefined;
        }
        default:
            return undefined;
    }
}

function getCallbackSessionId(data: string | undefined): string | undefined {
    if (!data?.startsWith(`${CALLBACK_PREFIX}:`)) {
        return undefined;
    }

    const [, sessionId] = data.split(":", 3);
    return sessionId;
}

function buildCallbackData(
    sessionId: string,
    action: "cancel" | "next" | "prev" | "save" | "sm" | "tt",
    index?: number
): string {
    return index === undefined
        ? `${CALLBACK_PREFIX}:${sessionId}:${action}`
        : `${CALLBACK_PREFIX}:${sessionId}:${action}:${index}`;
}

function buildPageButtons(
    session: TelegramConfigSessionRecord,
    itemCount: number
): TelegramInlineKeyboardButton[] {
    const buttons: TelegramInlineKeyboardButton[] = [];
    const maxPage = Math.max(0, Math.ceil(itemCount / PAGE_SIZE) - 1);

    if (session.currentPage > 0) {
        buttons.push({
            text: "Prev",
            callback_data: buildCallbackData(session.id, "prev"),
        });
    }

    if (session.currentPage < maxPage) {
        buttons.push({
            text: "Next",
            callback_data: buildCallbackData(session.id, "next"),
        });
    }

    return buttons;
}

function renderModelMenu(session: TelegramConfigSessionRecord): {
    replyMarkup: TelegramInlineKeyboardMarkup;
    text: string;
} {
    const start = session.currentPage * PAGE_SIZE;
    const pageItems = session.availableModels.slice(start, start + PAGE_SIZE);
    const rows: TelegramInlineKeyboardButton[][] = pageItems.map((modelName, index) => [{
        text: modelName === session.selectedModel ? `• ${modelName}` : modelName,
        callback_data: buildCallbackData(session.id, "sm", start + index),
    }]);

    const pageButtons = buildPageButtons(session, session.availableModels.length);
    if (pageButtons.length > 0) {
        rows.push(pageButtons);
    }
    rows.push([{
        text: "Cancel",
        callback_data: buildCallbackData(session.id, "cancel"),
    }]);

    return {
        text: [
            `Model picker for ${session.agentName}`,
            `Current model: ${session.selectedModel}`,
            `Page ${session.currentPage + 1} of ${Math.max(1, Math.ceil(session.availableModels.length / PAGE_SIZE))}`,
            "",
            "Tap a model to apply it immediately.",
        ].join("\n"),
        replyMarkup: {
            inline_keyboard: rows,
        },
    };
}

function renderToolsMenu(session: TelegramConfigSessionRecord): {
    replyMarkup: TelegramInlineKeyboardMarkup;
    text: string;
} {
    const start = session.currentPage * PAGE_SIZE;
    const pageItems = session.availableTools.slice(start, start + PAGE_SIZE);
    const selectedTools = new Set(session.selectedTools);
    const rows: TelegramInlineKeyboardButton[][] = pageItems.map((toolName, index) => [{
        text: `${selectedTools.has(toolName) ? "[x]" : "[ ]"} ${toolName}`,
        callback_data: buildCallbackData(session.id, "tt", start + index),
    }]);

    const pageButtons = buildPageButtons(session, session.availableTools.length);
    if (pageButtons.length > 0) {
        rows.push(pageButtons);
    }
    rows.push([
        {
            text: "Save",
            callback_data: buildCallbackData(session.id, "save"),
        },
        {
            text: "Cancel",
            callback_data: buildCallbackData(session.id, "cancel"),
        },
    ]);

    return {
        text: [
            `Tool picker for ${session.agentName}`,
            `Current model: ${session.selectedModel}`,
            `Selected tools: ${session.selectedTools.length}`,
            `Page ${session.currentPage + 1} of ${Math.max(1, Math.ceil(session.availableTools.length / PAGE_SIZE))}`,
            "",
            "Toggle tools, then tap Save.",
        ].join("\n"),
        replyMarkup: {
            inline_keyboard: rows,
        },
    };
}

function renderSession(session: TelegramConfigSessionRecord): {
    replyMarkup: TelegramInlineKeyboardMarkup;
    text: string;
} {
    return session.kind === "model"
        ? renderModelMenu(session)
        : renderToolsMenu(session);
}

function summarizeTools(tools: string[]): string {
    if (tools.length === 0) {
        return "no configurable tools";
    }

    if (tools.length <= 5) {
        return tools.join(", ");
    }

    return `${tools.slice(0, 5).join(", ")} (+${tools.length - 5} more)`;
}

export class TelegramConfigCommandService {
    private readonly configOptionsService: ProjectConfigOptionsService;
    private readonly configPublisher: AgentConfigPublisher;
    private readonly sessionStore: TelegramConfigSessionStore;

    constructor(params: {
        configOptionsService?: ProjectConfigOptionsService;
        configPublisher?: AgentConfigPublisher;
        sessionStore?: TelegramConfigSessionStore;
    } = {}) {
        this.configOptionsService =
            params.configOptionsService ?? new ProjectConfigOptionsService();
        this.configPublisher = params.configPublisher ?? new AgentConfigPublisher();
        this.sessionStore = params.sessionStore ?? getTelegramConfigSessionStore();
    }

    getCommandKind(
        update: TelegramUpdate,
        botUsername?: string
    ): TelegramConfigSessionKind | undefined {
        const command = this.getCommand(update, botUsername);
        return command?.type === "config" ? command.kind : undefined;
    }

    getCommand(
        update: TelegramUpdate,
        botUsername?: string
    ): TelegramGatewayCommand | undefined {
        const message = update.message ?? update.edited_message;
        const content = message?.text?.trim() || message?.caption?.trim();
        return content ? toGatewayCommand(content, botUsername) : undefined;
    }

    getCommandUsage(
        update: TelegramUpdate,
        botUsername?: string
    ): string | undefined {
        const command = this.getCommand(update, botUsername);
        if (!command) {
            return undefined;
        }

        const message = update.message ?? update.edited_message;
        const content = message?.text?.trim() || message?.caption?.trim() || "";
        const [, ...rest] = content.split(/\s+/);
        return rest.length > 0 ? toCommandUsage(command) : undefined;
    }

    getCallbackContext(update: TelegramUpdate): TelegramConfigCommandContext | null {
        const data = update.callback_query?.data;
        const sessionId = getCallbackSessionId(data);
        if (!sessionId) {
            return null;
        }
        const parsedAction = parseCallbackData(data);
        if (!parsedAction) {
            return null;
        }

        return {
            action: parsedAction,
            session: this.sessionStore.getSession(sessionId),
        };
    }

    async openCommandMenu(params: {
        binding: TelegramGatewayBinding;
        client: TelegramBotClient;
        commandKind: TelegramConfigSessionKind;
        currentModel: string;
        currentTools: string[];
        message: TelegramMessage;
        principalId: string;
        projectBinding: string;
        projectContext: Pick<ProjectContext, "agentRegistry" | "mcpManager">;
        projectId: string;
        projectTitle: string;
    }): Promise<void> {
        const options = await this.configOptionsService.getProjectOptions();
        if (
            (params.commandKind === "model" && options.models.length === 0) ||
            (params.commandKind === "tools" && options.tools.length === 0)
        ) {
            await params.client.sendMessage({
                chatId: String(params.message.chat.id),
                text: params.commandKind === "model"
                    ? "No models are available for this project."
                    : "No configurable tools are available for this project.",
                replyToMessageId: String(params.message.message_id),
                messageThreadId: params.message.message_thread_id !== undefined
                    ? String(params.message.message_thread_id)
                    : undefined,
            });
            return;
        }

        const session = this.sessionStore.createSession({
            agentName: params.binding.agent.name,
            agentPubkey: params.binding.agent.pubkey,
            availableModels: options.models,
            availableTools: options.tools,
            channelId: createTelegramChannelId(
                params.message.chat.id,
                params.message.message_thread_id
            ),
            chatId: String(params.message.chat.id),
            currentPage: 0,
            kind: params.commandKind,
            messageId: "",
            messageThreadId: params.message.message_thread_id !== undefined
                ? String(params.message.message_thread_id)
                : undefined,
            principalId: params.principalId,
            projectBinding: params.projectBinding,
            projectId: params.projectId,
            projectTitle: params.projectTitle,
            selectedModel: params.currentModel,
            selectedTools: options.tools.filter((toolName) => params.currentTools.includes(toolName)),
        });
        const rendered = renderSession(session);
        const sentMessage = await params.client.sendMessage({
            chatId: String(params.message.chat.id),
            text: rendered.text,
            replyMarkup: rendered.replyMarkup,
            replyToMessageId: String(params.message.message_id),
            messageThreadId: session.messageThreadId,
        });

        this.sessionStore.updateSession(session.id, {
            messageId: String(sentMessage.message_id),
        });
    }

    async handleCallback(params: {
        callbackContext: TelegramConfigCommandContext;
        client: TelegramBotClient;
        update: TelegramUpdate;
    }): Promise<void> {
        const callbackQuery = params.update.callback_query;
        const callbackContext = params.callbackContext;
        const session = callbackContext.session;

        if (!callbackQuery) {
            return;
        }

        if (!session) {
            await params.client.answerCallbackQuery({
                callbackQueryId: callbackQuery.id,
                showAlert: true,
                text: "This config menu expired. Run the command again.",
            });
            return;
        }

        if (callbackQuery.from.id && `telegram:user:${callbackQuery.from.id}` !== session.principalId) {
            await params.client.answerCallbackQuery({
                callbackQueryId: callbackQuery.id,
                showAlert: true,
                text: "Only the user who opened this menu can use it.",
            });
            return;
        }

        switch (callbackContext.action.type) {
            case "cancel":
                this.sessionStore.clearSession(session.id);
                await params.client.answerCallbackQuery({
                    callbackQueryId: callbackQuery.id,
                    text: "Cancelled",
                });
                await this.editSessionMessage(params.client, session, "Configuration menu cancelled.");
                return;
            case "next":
            case "previous": {
                const pageDelta = callbackContext.action.type === "next" ? 1 : -1;
                const maxPage = Math.max(
                    0,
                    Math.ceil(
                        (session.kind === "model"
                            ? session.availableModels.length
                            : session.availableTools.length) / PAGE_SIZE
                    ) - 1
                );
                const nextPage = Math.max(0, Math.min(maxPage, session.currentPage + pageDelta));
                const updatedSession = this.sessionStore.updateSession(session.id, {
                    currentPage: nextPage,
                }) ?? session;
                await params.client.answerCallbackQuery({
                    callbackQueryId: callbackQuery.id,
                });
                await this.editSessionMessage(params.client, updatedSession);
                return;
            }
            case "select-model": {
                const nextModel = session.availableModels[callbackContext.action.index];
                if (!nextModel) {
                    await params.client.answerCallbackQuery({
                        callbackQueryId: callbackQuery.id,
                        showAlert: true,
                        text: "That model is no longer available.",
                    });
                    return;
                }

                await this.configPublisher.publishProjectScopedUpdate({
                    projectBinding: session.projectBinding,
                    agentPubkey: session.agentPubkey,
                    model: nextModel,
                    tools: session.selectedTools,
                    clientTag: "tenex-telegram",
                });
                this.sessionStore.clearSession(session.id);
                await params.client.answerCallbackQuery({
                    callbackQueryId: callbackQuery.id,
                    text: `Applied model: ${nextModel}`,
                });
                await this.editSessionMessage(
                    params.client,
                    session,
                    `Updated ${session.agentName}.\nModel: ${nextModel}\nTools: ${summarizeTools(session.selectedTools)}`
                );
                return;
            }
            case "toggle-tool": {
                const toolName = session.availableTools[callbackContext.action.index];
                if (!toolName) {
                    await params.client.answerCallbackQuery({
                        callbackQueryId: callbackQuery.id,
                        showAlert: true,
                        text: "That tool is no longer available.",
                    });
                    return;
                }

                const selected = new Set(session.selectedTools);
                if (selected.has(toolName)) {
                    selected.delete(toolName);
                } else {
                    selected.add(toolName);
                }

                const updatedSession = this.sessionStore.updateSession(session.id, {
                    selectedTools: session.availableTools.filter((availableTool) =>
                        selected.has(availableTool)
                    ),
                }) ?? session;
                await params.client.answerCallbackQuery({
                    callbackQueryId: callbackQuery.id,
                    text: selected.has(toolName) ? `Enabled ${toolName}` : `Disabled ${toolName}`,
                });
                await this.editSessionMessage(params.client, updatedSession);
                return;
            }
            case "save": {
                await this.configPublisher.publishProjectScopedUpdate({
                    projectBinding: session.projectBinding,
                    agentPubkey: session.agentPubkey,
                    model: session.selectedModel,
                    tools: session.selectedTools,
                    clientTag: "tenex-telegram",
                });
                this.sessionStore.clearSession(session.id);
                await params.client.answerCallbackQuery({
                    callbackQueryId: callbackQuery.id,
                    text: "Saved",
                });
                await this.editSessionMessage(
                    params.client,
                    session,
                    `Updated ${session.agentName}.\nModel: ${session.selectedModel}\nTools: ${summarizeTools(session.selectedTools)}`
                );
                return;
            }
        }
    }

    private async editSessionMessage(
        client: TelegramBotClient,
        session: TelegramConfigSessionRecord,
        terminalText?: string
    ): Promise<void> {
        if (!session.messageId) {
            return;
        }

        if (terminalText) {
            await client.editMessageText({
                chatId: session.chatId,
                messageId: session.messageId,
                text: terminalText,
            });
            return;
        }

        const rendered = renderSession(session);
        await client.editMessageText({
            chatId: session.chatId,
            messageId: session.messageId,
            text: rendered.text,
            replyMarkup: rendered.replyMarkup,
        });
    }
}
