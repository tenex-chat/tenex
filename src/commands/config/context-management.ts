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

        await config.saveTenexConfig(globalPath, tenexConfig);
        console.log(chalk.green("\n✓ Context management settings updated"));
    });
