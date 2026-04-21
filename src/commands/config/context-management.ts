import {
    DEFAULT_COMPACTION_THRESHOLD_PERCENT,
    DEFAULT_TOOL_RESULT_DECAY_MIN_PLACEHOLDER_BATCH_SIZE,
    DEFAULT_WARNING_THRESHOLD_PERCENT,
    DEFAULT_WORKING_TOKEN_BUDGET,
} from "@/agents/execution/context-management/settings";
import { config } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const contextManagementCommand = new Command("context-management")
    .description("Configure managed context settings")
    .action(async () => {
        const globalPath = config.getGlobalPath();
        const tenexConfig = await config.loadTenexConfig(globalPath);
        const contextManagement = tenexConfig.contextManagement || {};

        const { action } = await inquirer.prompt([{
            type: "select",
            name: "action",
            message: "Context Management Settings",
            choices: [
                { name: "Configure settings", value: "configure" },
                { name: "Reset to defaults", value: "reset" },
                { name: chalk.dim("Back"), value: "back" },
            ],
            theme: inquirerTheme,
        }]);

        if (action === "back") return;

        if (action === "reset") {
            delete tenexConfig.contextManagement;
            delete tenexConfig.contextDiscovery;
            await config.saveTenexConfig(globalPath, tenexConfig);
            console.log(chalk.green("\n✓ Context management settings reset to defaults"));
            return;
        }

        const answers = await inquirer.prompt([
            {
                type: "confirm",
                name: "enabled",
                message: "Enable ai-sdk-context-management strategies:",
                default: contextManagement.enabled !== false,
            },
            {
                type: "input",
                name: "tokenBudget",
                message: "Token budget for managed context:",
                default: contextManagement.tokenBudget ?? DEFAULT_WORKING_TOKEN_BUDGET,
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num <= 0) {
                        return "Please enter a positive number";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "utilizationWarningThresholdPercent",
                message: "Utilization warning threshold (%):",
                default: (
                    contextManagement.utilizationWarningThresholdPercent
                    ?? DEFAULT_WARNING_THRESHOLD_PERCENT
                ),
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0 || num > 100) {
                        return "Please enter a number between 0 and 100";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "compactionThresholdPercent",
                message: "Automatic compaction threshold (%):",
                default: (
                    contextManagement.compactionThresholdPercent
                    ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT
                ),
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0 || num > 100) {
                        return "Please enter a number between 0 and 100";
                    }
                    return true;
                },
            },
        ]);

        const toolDecay = contextManagement.toolResultDecay || {};
        const toolDecayAnswers = await inquirer.prompt([
            {
                type: "input",
                name: "minTotalSavingsTokens",
                message: "Tool decay minimum savings threshold (tokens):",
                default: toolDecay.minTotalSavingsTokens ?? 20_000,
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0) {
                        return "Please enter a non-negative number";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "minDepth",
                message: "Tool decay minimum age (messages ago):",
                default: toolDecay.minDepth ?? 20,
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0) {
                        return "Please enter a non-negative number";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "minPlaceholderBatchSize",
                message: "Tool decay minimum placeholder batch size:",
                default: (
                    toolDecay.minPlaceholderBatchSize
                    ?? DEFAULT_TOOL_RESULT_DECAY_MIN_PLACEHOLDER_BATCH_SIZE
                ),
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 5) {
                        return "Please enter an integer 5 or greater";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "excludeToolNames",
                message: "Tool decay excluded tool names (comma-separated):",
                default: (toolDecay.excludeToolNames || ["delegate", "delegate_followup"]).join(", "),
            },
        ]);

        const strategyAnswers = await inquirer.prompt([
            {
                type: "confirm",
                name: "reminders",
                message: "Enable RemindersStrategy:",
                default: contextManagement.strategies?.reminders !== false,
            },
            {
                type: "confirm",
                name: "toolResultDecay",
                message: "Enable ToolResultDecayStrategy:",
                default: contextManagement.strategies?.toolResultDecay !== false,
            },
            {
                type: "confirm",
                name: "compaction",
                message: "Enable CompactionToolStrategy:",
                default: contextManagement.strategies?.compaction !== false,
            },
            {
                type: "confirm",
                name: "contextUtilizationReminder",
                message: "Enable reminders context-utilization source:",
                default: contextManagement.strategies?.contextUtilizationReminder !== false,
            },
            {
                type: "confirm",
                name: "contextWindowStatus",
                message: "Enable reminders context-window-status source:",
                default: contextManagement.strategies?.contextWindowStatus !== false,
            },
        ]);

        const contextDiscovery = tenexConfig.contextDiscovery || {};
        const discoveryAnswers = await inquirer.prompt([
            {
                type: "confirm",
                name: "enabled",
                message: "Enable proactive context discovery:",
                default: contextDiscovery.enabled !== false,
            },
            {
                type: "select",
                name: "trigger",
                message: "Run context discovery:",
                choices: [
                    { name: "When a conversation starts", value: "new-conversation" },
                    { name: "Before every turn", value: "every-turn" },
                ],
                default: contextDiscovery.trigger ?? "new-conversation",
                theme: inquirerTheme,
            },
            {
                type: "input",
                name: "timeoutMs",
                message: "Context discovery hot-path timeout (ms):",
                default: contextDiscovery.timeoutMs ?? 1200,
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num <= 0) {
                        return "Please enter a positive number";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "maxQueries",
                message: "Maximum discovery search queries:",
                default: contextDiscovery.maxQueries ?? 4,
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 1 || num > 8) {
                        return "Please enter a number from 1 to 8";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "maxHints",
                message: "Maximum context hints to inject:",
                default: contextDiscovery.maxHints ?? 5,
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 1 || num > 12) {
                        return "Please enter a number from 1 to 12";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "minScore",
                message: "Minimum relevance score (0-1):",
                default: contextDiscovery.minScore ?? 0.45,
                validate: (value) => {
                    const num = Number.parseFloat(value);
                    if (Number.isNaN(num) || num < 0 || num > 1) {
                        return "Please enter a number from 0 to 1";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "sources",
                message: "Discovery sources (comma-separated: conversations, lessons, rag):",
                default: (contextDiscovery.sources || ["conversations", "lessons", "rag"]).join(", "),
                validate: (value) => {
                    const allowed = new Set(["conversations", "lessons", "rag"]);
                    const sources = String(value)
                        .split(",")
                        .map((source) => source.trim())
                        .filter(Boolean);
                    if (sources.length === 0 || sources.some((source) => !allowed.has(source))) {
                        return "Use one or more of: conversations, lessons, rag";
                    }
                    return true;
                },
            },
            {
                type: "confirm",
                name: "usePlannerModel",
                message: "Use the contextDiscovery model to plan searches:",
                default: contextDiscovery.usePlannerModel ?? false,
            },
            {
                type: "confirm",
                name: "useRerankerModel",
                message: "Use the contextDiscovery model to rerank hints:",
                default: contextDiscovery.useRerankerModel ?? false,
            },
            {
                type: "confirm",
                name: "backgroundCompletionReminders",
                message: "Surface late context discovery results on a later turn:",
                default: contextDiscovery.backgroundCompletionReminders !== false,
            },
        ]);

        tenexConfig.contextManagement = {
            enabled: answers.enabled,
            tokenBudget: Number.parseInt(answers.tokenBudget, 10),
            utilizationWarningThresholdPercent: Number.parseInt(answers.utilizationWarningThresholdPercent, 10),
            compactionThresholdPercent: Number.parseInt(answers.compactionThresholdPercent, 10),
            toolResultDecay: {
                minTotalSavingsTokens: Number.parseInt(toolDecayAnswers.minTotalSavingsTokens, 10),
                minDepth: Number.parseInt(toolDecayAnswers.minDepth, 10),
                minPlaceholderBatchSize: Number.parseInt(toolDecayAnswers.minPlaceholderBatchSize, 10),
                excludeToolNames: toolDecayAnswers.excludeToolNames
                    .split(",")
                    .map((name: string) => name.trim())
                    .filter((name: string) => name.length > 0),
            },
            strategies: {
                reminders: strategyAnswers.reminders,
                toolResultDecay: strategyAnswers.toolResultDecay,
                compaction: strategyAnswers.compaction,
                contextUtilizationReminder: strategyAnswers.contextUtilizationReminder,
                contextWindowStatus: strategyAnswers.contextWindowStatus,
            },
        };

        tenexConfig.contextDiscovery = {
            ...contextDiscovery,
            enabled: discoveryAnswers.enabled,
            trigger: discoveryAnswers.trigger,
            timeoutMs: Number.parseInt(discoveryAnswers.timeoutMs, 10),
            maxQueries: Number.parseInt(discoveryAnswers.maxQueries, 10),
            maxHints: Number.parseInt(discoveryAnswers.maxHints, 10),
            minScore: Number.parseFloat(discoveryAnswers.minScore),
            sources: discoveryAnswers.sources
                .split(",")
                .map((source: string) => source.trim())
                .filter((source: string) => source.length > 0) as Array<"conversations" | "lessons" | "rag">,
            usePlannerModel: discoveryAnswers.usePlannerModel,
            useRerankerModel: discoveryAnswers.useRerankerModel,
            backgroundCompletionReminders: discoveryAnswers.backgroundCompletionReminders,
        };

        await config.saveTenexConfig(globalPath, tenexConfig);
        console.log(chalk.green("\n✓ Context management settings updated"));
    });
