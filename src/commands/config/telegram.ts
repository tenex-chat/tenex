import {
    agentStorage,
    deriveAgentPubkeyFromNsec,
    type StoredAgent,
} from "@/agents/AgentStorage";
import type { TelegramAgentConfig } from "@/agents/types";
import { config as configService } from "@/services/ConfigService";
import { getTransportBindingStore } from "@/services/ingress/TransportBindingStoreService";
import { getIdentityBindingStore } from "@/services/identity";
import { getTelegramChatContextStore } from "@/services/telegram/TelegramChatContextStoreService";
import { parseTelegramChannelId } from "@/utils/telegram-identifiers";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

type TelegramDraft = {
    botToken?: string;
    allowDMs?: boolean;
    apiBaseUrl?: string;
};

type RememberedBindingSummary = {
    projectId: string;
    channelId: string;
    description?: string;
};

function toDraft(config: TelegramAgentConfig | undefined): TelegramDraft | undefined {
    if (!config) {
        return undefined;
    }

    return {
        botToken: config.botToken,
        allowDMs: config.allowDMs,
        apiBaseUrl: config.apiBaseUrl,
    };
}

function uniq(values: string[]): string[] {
    return Array.from(new Set(values));
}

function normalizeTelegramDraft(draft: TelegramDraft | undefined): TelegramAgentConfig | undefined {
    if (!draft) {
        return undefined;
    }

    const botToken = draft.botToken?.trim();
    if (!botToken) {
        return undefined;
    }

    return {
        botToken,
        allowDMs: draft.allowDMs,
        apiBaseUrl: draft.apiBaseUrl?.trim() || undefined,
    };
}

function formatHandle(username: string | undefined): string {
    return username ? ` (@${username})` : "";
}

function formatIdentityLabel(
    displayName: string | undefined,
    username: string | undefined,
    fallback: string
): string {
    const base = displayName ?? username ?? fallback;
    if (!username || base === username) {
        return base;
    }
    return `${base}${formatHandle(username)}`;
}

function describeRememberedBinding(
    pubkey: string,
    projectId: string,
    channelId: string
): string | undefined {
    const parsed = parseTelegramChannelId(channelId);
    if (!parsed) {
        return undefined;
    }

    if (!parsed.chatId.startsWith("-")) {
        const identity = getIdentityBindingStore().getBinding(`telegram:user:${parsed.chatId}`);
        return `Telegram DM with ${formatIdentityLabel(
            identity?.displayName,
            identity?.username,
            parsed.chatId
        )}`;
    }

    const chatContext = getTelegramChatContextStore().getContext(projectId, pubkey, channelId);
    if (!chatContext?.chatTitle && !chatContext?.chatUsername) {
        return parsed.messageThreadId ? "Telegram topic" : "Telegram chat";
    }

    const title = chatContext.chatTitle
        ? `"${chatContext.chatTitle}"`
        : chatContext.chatUsername
          ? `@${chatContext.chatUsername}`
          : undefined;
    if (!title) {
        return parsed.messageThreadId ? "Telegram topic" : "Telegram chat";
    }

    return parsed.messageThreadId
        ? `Telegram topic in ${title}`
        : `Telegram chat ${title}`;
}

function listRememberedBindings(pubkey: string): RememberedBindingSummary[] {
    return getTransportBindingStore()
        .listBindings()
        .filter((binding) => binding.agentPubkey === pubkey && binding.transport === "telegram")
        .sort((left, right) =>
            left.projectId.localeCompare(right.projectId) ||
            left.channelId.localeCompare(right.channelId)
        )
        .map((binding) => ({
            projectId: binding.projectId,
            channelId: binding.channelId,
            description: describeRememberedBinding(pubkey, binding.projectId, binding.channelId),
        }));
}

function summarizeTelegramConfig(
    config: TelegramAgentConfig | undefined,
    pubkey: string
): string[] {
    const rememberedBindings = listRememberedBindings(pubkey);
    const lines = [
        `  Bot token: ${config?.botToken ? maskToken(config.botToken) : chalk.dim("not configured")}`,
        `  DMs enabled: ${config
            ? config.allowDMs === false ? "no" : "yes"
            : chalk.dim("no bot configured")}`,
        `  API base URL: ${config?.apiBaseUrl ?? chalk.dim("default")}`,
        `  Remembered project bindings: ${rememberedBindings.length}`,
    ];

    if (rememberedBindings.length > 0) {
        lines.push("  Bound channels by project:");

        let currentProjectId: string | undefined;
        for (const binding of rememberedBindings) {
            if (binding.projectId !== currentProjectId) {
                currentProjectId = binding.projectId;
                lines.push(`    ${currentProjectId}`);
            }

            lines.push(
                `      ${binding.channelId}${binding.description ? ` [${binding.description}]` : ""}`
            );
        }
    }

    return lines;
}

function maskToken(token: string): string {
    if (token.length <= 8) {
        return token;
    }

    return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

async function chooseAgent(): Promise<{ agent: StoredAgent; pubkey: string } | undefined> {
    await agentStorage.initialize();
    const agents = (await agentStorage.getCanonicalActiveAgents())
        .sort((left, right) => left.slug.localeCompare(right.slug));

    if (agents.length === 0) {
        console.log(chalk.dim("  No active agents found."));
        return undefined;
    }

    const choices: Array<{
        name: string;
        value: { agent: StoredAgent; pubkey: string } | undefined;
    }> = await Promise.all(agents.map(async (agent) => {
        const pubkey = deriveAgentPubkeyFromNsec(agent.nsec);
        const projects = await agentStorage.getAgentProjects(pubkey);
        return {
            name: `${agent.slug} — ${agent.name} (${projects.length} project${projects.length === 1 ? "" : "s"})`,
            value: { agent, pubkey },
        };
    }));

    choices.push({ name: chalk.dim("Back"), value: undefined });

    const { selection } = await inquirer.prompt([{
        type: "select",
        name: "selection",
        message: "Choose an agent",
        choices,
        theme: inquirerTheme,
        loop: false,
    }]);

    return selection as { agent: StoredAgent; pubkey: string } | undefined;
}

async function promptForBotToken(current: string | undefined): Promise<string | undefined> {
    const { botToken } = await inquirer.prompt([{
        type: "password",
        name: "botToken",
        message: "Telegram Bot API token:",
        default: current ?? "",
        mask: "*",
        theme: inquirerTheme,
        validate: (input: string) => input.trim().length > 0 || "Bot token cannot be empty",
    }]);

    return botToken.trim();
}

async function promptForApiBaseUrl(current: string | undefined): Promise<string | undefined> {
    const { apiBaseUrl } = await inquirer.prompt([{
        type: "input",
        name: "apiBaseUrl",
        message: "Telegram API base URL (leave blank for default):",
        default: current ?? "",
        theme: inquirerTheme,
    }]);

    const trimmed = apiBaseUrl.trim();
    return trimmed || undefined;
}

async function configureAgentTelegram(): Promise<void> {
    while (true) {
        const selection = await chooseAgent();
        if (!selection) {
            return;
        }

        const { pubkey } = selection;

        while (true) {
            const freshAgent = await agentStorage.loadAgent(pubkey);
            if (!freshAgent) {
                console.log(chalk.red("❌ Agent disappeared while editing."));
                return;
            }

            const currentConfig = freshAgent.telegram;
            console.log();
            console.log(chalk.bold(`${freshAgent.slug} — Telegram transport`));
            for (const line of summarizeTelegramConfig(currentConfig, pubkey)) {
                console.log(line);
            }
            console.log();

            const { action } = await inquirer.prompt([{
                type: "select",
                name: "action",
                message: "Telegram transport",
                choices: [
                    { name: "Set or replace bot token", value: "token" },
                    { name: "Set or clear API base URL", value: "apiBaseUrl" },
                    { name: "Toggle DMs", value: "dms" },
                    { name: "Disable Telegram for this agent", value: "reset" },
                    { name: "Back", value: "back" },
                ],
                theme: inquirerTheme,
                loop: false,
            }]);

            if (action === "back") {
                break;
            }

            if (action === "reset") {
                await agentStorage.updateAgentTelegramConfig(pubkey, undefined);
                console.log(chalk.green("✓") + chalk.bold(" Telegram transport updated."));
                continue;
            }

            const nextDraft = toDraft(currentConfig) ?? {};

            if (action === "token") {
                nextDraft.botToken = await promptForBotToken(nextDraft.botToken);
            } else if (action === "apiBaseUrl") {
                if (!nextDraft.botToken) {
                    console.log(chalk.yellow("  Set a bot token first."));
                    continue;
                }
                nextDraft.apiBaseUrl = await promptForApiBaseUrl(nextDraft.apiBaseUrl);
            } else if (action === "dms") {
                if (!nextDraft.botToken) {
                    console.log(chalk.yellow("  Set a bot token first."));
                    continue;
                }
                nextDraft.allowDMs = nextDraft.allowDMs === false;
            }

            await agentStorage.updateAgentTelegramConfig(pubkey, normalizeTelegramDraft(nextDraft));
            console.log(chalk.green("✓") + chalk.bold(" Telegram transport updated."));
        }
    }
}

function mergeTelegramIdentityList(
    existing: string[],
    telegramIdentities: string[]
): string[] {
    const nonTelegram = existing.filter((identityId) => !identityId.startsWith("telegram:"));
    return [...nonTelegram, ...uniq(telegramIdentities)];
}

async function configureGlobalTelegramDMAllowlist(): Promise<void> {
    const globalPath = configService.getGlobalPath();
    const existingConfig = await configService.loadTenexConfig(globalPath);
    let telegramIdentities = uniq(
        (existingConfig.whitelistedIdentities ?? [])
            .map((identityId) => identityId.trim())
            .filter((identityId) => identityId.startsWith("telegram:"))
    );

    while (true) {
        console.log();
        console.log("  Global Telegram DM allowlist:");
        if (telegramIdentities.length === 0) {
            console.log(chalk.dim("    none"));
        } else {
            for (const identityId of telegramIdentities) {
                console.log(`    ${identityId}`);
            }
        }

        const { action } = await inquirer.prompt([{
            type: "select",
            name: "action",
            message: "Global Telegram DM access",
            choices: [
                { name: "Add an identity", value: "add" },
                { name: "Remove an identity", value: "remove" },
                { name: "Clear all Telegram identities", value: "clear" },
                { name: "Back", value: "back" },
            ],
            theme: inquirerTheme,
            loop: false,
        }]);

        if (action === "back") {
            return;
        }

        if (action === "add") {
            const { identityId } = await inquirer.prompt([{
                type: "input",
                name: "identityId",
                message: "Telegram principal ID (for example telegram:user:12345):",
                theme: inquirerTheme,
                validate: (input: string) =>
                    input.trim().startsWith("telegram:") || "Principal IDs must start with telegram:",
            }]);

            telegramIdentities = uniq([...telegramIdentities, identityId.trim()]);
        } else if (action === "remove") {
            if (telegramIdentities.length === 0) {
                continue;
            }

            const { identityId } = await inquirer.prompt([{
                type: "select",
                name: "identityId",
                message: "Remove which identity?",
                choices: telegramIdentities.map((identity) => ({ name: identity, value: identity })),
                theme: inquirerTheme,
                loop: false,
            }]);

            telegramIdentities = telegramIdentities.filter((identity) => identity !== identityId);
        } else {
            telegramIdentities = [];
        }

        existingConfig.whitelistedIdentities = mergeTelegramIdentityList(
            existingConfig.whitelistedIdentities ?? [],
            telegramIdentities
        );
        await configService.saveGlobalConfig(existingConfig);
        console.log(chalk.green("✓") + chalk.bold(" Global Telegram DM allowlist saved."));
    }
}

async function runTelegramMenu(): Promise<void> {
    while (true) {
        console.log();

        const { action } = await inquirer.prompt([{
            type: "select",
            name: "action",
            message: "Telegram settings",
            choices: [
                { name: "Configure an agent Telegram bot", value: "agent" },
                { name: "Configure global Telegram DM allowlist", value: "global" },
                { name: "Back", value: "back" },
            ],
            theme: inquirerTheme,
            loop: false,
        }]);

        if (action === "back") {
            return;
        }

        if (action === "agent") {
            await configureAgentTelegram();
            continue;
        }

        await configureGlobalTelegramDMAllowlist();
    }
}

export const telegramCommand = new Command("telegram")
    .description("Configure agent Telegram bots, global DM access, and remembered project bindings")
    .action(async () => {
        try {
            await runTelegramMenu();
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure Telegram: ${error}`));
            process.exitCode = 1;
        }
    });
