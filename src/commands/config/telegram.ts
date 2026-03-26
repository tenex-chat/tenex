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

type TelegramScope =
    | { kind: "default" }
    | { kind: "project"; projectId: string };

type TelegramDraft = {
    botToken?: string;
    allowDMs?: boolean;
    authorizedIdentityIds?: string[];
    apiBaseUrl?: string;
};

function toDraft(config: TelegramAgentConfig | undefined): TelegramDraft | undefined {
    if (!config) {
        return undefined;
    }

    return {
        botToken: config.botToken,
        allowDMs: config.allowDMs,
        authorizedIdentityIds: config.authorizedIdentityIds ? [...config.authorizedIdentityIds] : undefined,
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

    const authorizedIdentityIds = uniq(
        (draft.authorizedIdentityIds ?? [])
            .map((identityId) => identityId.trim())
            .filter(Boolean)
    );

    return {
        botToken,
        allowDMs: draft.allowDMs,
        authorizedIdentityIds: authorizedIdentityIds.length > 0 ? authorizedIdentityIds : undefined,
        apiBaseUrl: draft.apiBaseUrl?.trim() || undefined,
    };
}

function scopeLabel(scope: TelegramScope): string {
    return scope.kind === "default"
        ? "Default (all projects without an override)"
        : `Project override: ${scope.projectId}`;
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

function listRememberedBindings(pubkey: string, scope: TelegramScope): Array<{
    channelId: string;
    description?: string;
}> {
    if (scope.kind !== "project") {
        return [];
    }

    return getTransportBindingStore()
        .listBindingsForAgentProject(pubkey, scope.projectId, "telegram")
        .map((binding) => ({
            channelId: binding.channelId,
            description: describeRememberedBinding(pubkey, scope.projectId, binding.channelId),
        }));
}

function summarizeTelegramConfig(
    config: TelegramAgentConfig | undefined,
    scope: TelegramScope,
    pubkey: string
): string[] {
    if (!config) {
        return [chalk.dim("  Telegram is not configured for this scope.")];
    }

    const authorizedIdentityIds = config.authorizedIdentityIds ?? [];
    const rememberedBindings = listRememberedBindings(pubkey, scope);
    const lines = [
        `  Bot token: ${maskToken(config.botToken)}`,
        `  DMs enabled: ${config.allowDMs === false ? "no" : "yes"}`,
        `  Authorized identities: ${authorizedIdentityIds.length}`,
        scope.kind === "project"
            ? `  Remembered bindings: ${rememberedBindings.length}`
            : `  Remembered bindings: ${chalk.dim("project-scoped")}`,
        `  API base URL: ${config.apiBaseUrl ?? chalk.dim("default")}`,
    ];

    if (authorizedIdentityIds.length > 0) {
        lines.push(`  Identity list: ${authorizedIdentityIds.join(", ")}`);
    }

    if (rememberedBindings.length > 0) {
        lines.push("  Remembered channels:");
        for (const binding of rememberedBindings) {
            lines.push(`    ${binding.channelId}${binding.description ? ` [${binding.description}]` : ""}`);
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

function getDefaultTelegramConfig(agent: StoredAgent): TelegramAgentConfig | undefined {
    return agent.default?.telegram;
}

function getScopedTelegramConfig(agent: StoredAgent, scope: TelegramScope): TelegramAgentConfig | undefined {
    if (scope.kind === "default") {
        return getDefaultTelegramConfig(agent);
    }

    return agentStorage.getEffectiveConfig(agent, scope.projectId).telegram;
}

async function saveScopedTelegramConfig(
    pubkey: string,
    scope: TelegramScope,
    draft: TelegramDraft | undefined
): Promise<void> {
    const normalized = normalizeTelegramDraft(draft);

    if (scope.kind === "default") {
        await agentStorage.updateDefaultTelegramConfig(pubkey, normalized);
        return;
    }

    await agentStorage.updateProjectTelegramConfig(pubkey, scope.projectId, normalized);
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

async function chooseScope(agent: StoredAgent, pubkey: string): Promise<TelegramScope | undefined> {
    const projectIds = await agentStorage.getAgentProjects(pubkey);
    const choices: Array<{ name: string; value: TelegramScope | undefined }> = [
        {
            name: "Default (all projects without an override)",
            value: { kind: "default" },
        },
        ...projectIds
            .sort()
            .map((projectId) => ({
                name: `Project override: ${projectId}`,
                value: { kind: "project" as const, projectId },
            })),
        {
            name: chalk.dim("Back"),
            value: undefined,
        },
    ];

    const { scope } = await inquirer.prompt([{
        type: "select",
        name: "scope",
        message: `Choose a Telegram config scope for ${agent.slug}`,
        choices,
        theme: inquirerTheme,
        loop: false,
    }]);

    return scope as TelegramScope | undefined;
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

async function manageAuthorizedIdentities(
    draft: TelegramDraft
): Promise<TelegramDraft> {
    const nextDraft: TelegramDraft = {
        ...draft,
        authorizedIdentityIds: [...(draft.authorizedIdentityIds ?? [])],
    };

    while (true) {
        const identities = nextDraft.authorizedIdentityIds ?? [];
        console.log();
        console.log("  Authorized Telegram identities:");
        if (identities.length === 0) {
            console.log(chalk.dim("    none"));
        } else {
            for (const identity of identities) {
                console.log(`    ${identity}`);
            }
        }

        const { action } = await inquirer.prompt([{
            type: "select",
            name: "action",
            message: "Manage agent Telegram identities",
            choices: [
                { name: "Add an identity", value: "add" },
                { name: "Remove an identity", value: "remove" },
                { name: "Clear all", value: "clear" },
                { name: "Back", value: "back" },
            ],
            theme: inquirerTheme,
            loop: false,
        }]);

        if (action === "back") {
            return nextDraft;
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

            nextDraft.authorizedIdentityIds = uniq([
                ...(nextDraft.authorizedIdentityIds ?? []),
                identityId.trim(),
            ]);
            continue;
        }

        if (action === "remove") {
            if (identities.length === 0) {
                continue;
            }

            const { identityId } = await inquirer.prompt([{
                type: "select",
                name: "identityId",
                message: "Remove which identity?",
                choices: identities.map((identity) => ({ name: identity, value: identity })),
                theme: inquirerTheme,
                loop: false,
            }]);

            nextDraft.authorizedIdentityIds = identities.filter((identity) => identity !== identityId);
            continue;
        }

        nextDraft.authorizedIdentityIds = [];
    }
}

async function configureAgentTelegram(): Promise<void> {
    while (true) {
        const selection = await chooseAgent();
        if (!selection) {
            return;
        }

        const { pubkey } = selection;
        const scope = await chooseScope(selection.agent, pubkey);
        if (!scope) {
            continue;
        }

        while (true) {
            const freshAgent = await agentStorage.loadAgent(pubkey);
            if (!freshAgent) {
                console.log(chalk.red("❌ Agent disappeared while editing."));
                return;
            }

            const currentConfig = getScopedTelegramConfig(freshAgent, scope);
            console.log();
            console.log(chalk.bold(`${freshAgent.slug} — ${scopeLabel(scope)}`));
            for (const line of summarizeTelegramConfig(currentConfig, scope, pubkey)) {
                console.log(line);
            }
            console.log();

            const resetLabel = scope.kind === "default"
                ? "Disable Telegram for this agent"
                : "Reset this project to the inherited/default Telegram config";

            const { action } = await inquirer.prompt([{
                type: "select",
                name: "action",
                message: "Telegram settings",
                choices: [
                    { name: "Set or replace bot token", value: "token" },
                    { name: "Set or clear API base URL", value: "apiBaseUrl" },
                    { name: "Toggle DMs", value: "dms" },
                    { name: "Manage authorized identities", value: "identities" },
                    { name: resetLabel, value: "reset" },
                    { name: "Back", value: "back" },
                ],
                theme: inquirerTheme,
                loop: false,
            }]);

            if (action === "back") {
                break;
            }

            if (action === "reset") {
                await saveScopedTelegramConfig(pubkey, scope, undefined);
                console.log(chalk.green("✓") + chalk.bold(" Telegram config updated."));
                continue;
            }

            let nextDraft = toDraft(currentConfig) ?? {};

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
            } else if (action === "identities") {
                if (!nextDraft.botToken) {
                    console.log(chalk.yellow("  Set a bot token first."));
                    continue;
                }
                nextDraft = await manageAuthorizedIdentities(nextDraft);
            }

            await saveScopedTelegramConfig(pubkey, scope, nextDraft);
            console.log(chalk.green("✓") + chalk.bold(" Telegram config updated."));
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

async function configureGlobalTelegramIdentities(): Promise<void> {
    const globalPath = configService.getGlobalPath();
    const existingConfig = await configService.loadTenexConfig(globalPath);
    let telegramIdentities = uniq(
        (existingConfig.whitelistedIdentities ?? [])
            .map((identityId) => identityId.trim())
            .filter((identityId) => identityId.startsWith("telegram:"))
    );

    while (true) {
        console.log();
        console.log("  Global Telegram identities:");
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
            message: "Global Telegram identity access",
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
        console.log(chalk.green("✓") + chalk.bold(" Global Telegram identities saved."));
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
                { name: "Configure an agent Telegram transport", value: "agent" },
                { name: "Configure global Telegram identities", value: "global" },
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

        await configureGlobalTelegramIdentities();
    }
}

export const telegramCommand = new Command("telegram")
    .description("Configure Telegram bot tokens, DM access, and chat bindings")
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
