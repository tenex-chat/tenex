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
                default: contextManagement.tokenBudget ?? 40000,
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
                name: "forceScratchpadThresholdPercent",
                message: "Force scratchpad threshold (%):",
                default: contextManagement.forceScratchpadThresholdPercent ?? 70,
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
                name: "utilizationWarningThresholdPercent",
                message: "Utilization warning threshold (%):",
                default: contextManagement.utilizationWarningThresholdPercent ?? 70,
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
                default: contextManagement.compactionThresholdPercent ?? 90,
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0 || num > 100) {
                        return "Please enter a number between 0 and 100";
                    }
                    return true;
                },
            },
        ]);

        const strategyAnswers = await inquirer.prompt([
            {
                type: "confirm",
                name: "systemPromptCaching",
                message: "Enable SystemPromptCachingStrategy:",
                default: contextManagement.strategies?.systemPromptCaching !== false,
            },
            {
                type: "confirm",
                name: "scratchpad",
                message: "Enable ScratchpadStrategy:",
                default: contextManagement.strategies?.scratchpad !== false,
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
                message: "Enable ContextUtilizationReminderStrategy:",
                default: contextManagement.strategies?.contextUtilizationReminder !== false,
            },
            {
                type: "confirm",
                name: "contextWindowStatus",
                message: "Enable ContextWindowStatusStrategy:",
                default: contextManagement.strategies?.contextWindowStatus !== false,
            },
        ]);

        tenexConfig.contextManagement = {
            enabled: answers.enabled,
            tokenBudget: Number.parseInt(answers.tokenBudget, 10),
            forceScratchpadThresholdPercent: Number.parseInt(answers.forceScratchpadThresholdPercent, 10),
            utilizationWarningThresholdPercent: Number.parseInt(answers.utilizationWarningThresholdPercent, 10),
            compactionThresholdPercent: Number.parseInt(answers.compactionThresholdPercent, 10),
            strategies: {
                systemPromptCaching: strategyAnswers.systemPromptCaching,
                scratchpad: strategyAnswers.scratchpad,
                toolResultDecay: strategyAnswers.toolResultDecay,
                compaction: strategyAnswers.compaction,
                contextUtilizationReminder: strategyAnswers.contextUtilizationReminder,
                contextWindowStatus: strategyAnswers.contextWindowStatus,
            },
        };

        await config.saveTenexConfig(globalPath, tenexConfig);
        console.log(chalk.green("\n✓ Context management settings updated"));
    });
