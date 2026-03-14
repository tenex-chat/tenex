import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const contextManagementCommand = new Command("context-management")
    .alias("context")
    .alias("compression")
    .description("Configure request-time context management — graduated decay, summarization fallback, scratchpad, and warnings")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const contextManagement = {
                ...existingConfig.compression,
                ...existingConfig.contextManagement,
            };

            const currentSettings = {
                enabled: contextManagement.enabled ?? true,
                tokenBudget: contextManagement.tokenBudget ?? 40000,
                scratchpadEnabled: contextManagement.scratchpadEnabled ?? true,
                forceScratchpadEnabled: contextManagement.forceScratchpadEnabled ?? true,
                forceScratchpadThresholdPercent:
                    contextManagement.forceScratchpadThresholdPercent ?? 70,
                utilizationWarningEnabled: contextManagement.utilizationWarningEnabled ?? true,
                utilizationWarningThresholdPercent:
                    contextManagement.utilizationWarningThresholdPercent ?? 70,
                summarizationFallbackEnabled:
                    contextManagement.summarizationFallbackEnabled ?? true,
                summarizationFallbackThresholdPercent:
                    contextManagement.summarizationFallbackThresholdPercent ?? 90,
            };

            console.log(`  Enabled: ${currentSettings.enabled}`);
            console.log(`  Working token budget: ${currentSettings.tokenBudget}`);
            console.log(`  Scratchpad strategy: ${currentSettings.scratchpadEnabled}`);
            console.log(
                `  Forced scratchpad step: ${currentSettings.forceScratchpadEnabled} @ ${currentSettings.forceScratchpadThresholdPercent}%`
            );
            console.log(
                `  Utilization warning: ${currentSettings.utilizationWarningEnabled} @ ${currentSettings.utilizationWarningThresholdPercent}%`
            );
            console.log(
                `  Summarization fallback: ${currentSettings.summarizationFallbackEnabled} @ ${currentSettings.summarizationFallbackThresholdPercent}%\n`
            );

            const { enabled } = await inquirer.prompt([{
                type: "confirm",
                name: "enabled",
                message: "Enable context management?",
                default: currentSettings.enabled,
                theme: inquirerTheme,
            }]);

            if (enabled) {
                const answers = await inquirer.prompt([
                    {
                        type: "input",
                        name: "tokenBudget",
                        message: "Working token budget:",
                        default: String(currentSettings.tokenBudget),
                        theme: inquirerTheme,
                        validate: (input: string) => /^\d+$/.test(input) || "Must be a number",
                    },
                    {
                        type: "confirm",
                        name: "scratchpadEnabled",
                        message: "Enable scratchpad strategy/tool?",
                        default: currentSettings.scratchpadEnabled,
                        theme: inquirerTheme,
                    },
                    {
                        type: "confirm",
                        name: "forceScratchpadEnabled",
                        message: "Force a scratchpad tool call when the working budget gets tight?",
                        default: currentSettings.forceScratchpadEnabled,
                        theme: inquirerTheme,
                        when: (answers: { scratchpadEnabled?: boolean }) =>
                            answers.scratchpadEnabled === true,
                    },
                    {
                        type: "input",
                        name: "forceScratchpadThresholdPercent",
                        message: "Forced scratchpad threshold (% of working budget):",
                        default: String(currentSettings.forceScratchpadThresholdPercent),
                        theme: inquirerTheme,
                        when: (answers: {
                            scratchpadEnabled?: boolean;
                            forceScratchpadEnabled?: boolean;
                        }) =>
                            answers.scratchpadEnabled === true
                            && answers.forceScratchpadEnabled === true,
                        validate: (input: string) =>
                            /^\d+$/.test(input) &&
                                Number(input) >= 1 &&
                                Number(input) <= 100
                                ? true
                                : "Must be a number between 1 and 100",
                    },
                    {
                        type: "confirm",
                        name: "utilizationWarningEnabled",
                        message: "Enable utilization warnings?",
                        default: currentSettings.utilizationWarningEnabled,
                        theme: inquirerTheme,
                    },
                    {
                        type: "input",
                        name: "utilizationWarningThresholdPercent",
                        message: "Utilization warning threshold (% of working budget):",
                        default: String(currentSettings.utilizationWarningThresholdPercent),
                        theme: inquirerTheme,
                        when: (answers: { utilizationWarningEnabled?: boolean }) =>
                            answers.utilizationWarningEnabled === true,
                        validate: (input: string) =>
                            /^\d+$/.test(input) &&
                                Number(input) >= 1 &&
                                Number(input) <= 100
                                ? true
                                : "Must be a number between 1 and 100",
                    },
                    {
                        type: "confirm",
                        name: "summarizationFallbackEnabled",
                        message: "Enable summarization fallback?",
                        default: currentSettings.summarizationFallbackEnabled,
                        theme: inquirerTheme,
                    },
                    {
                        type: "input",
                        name: "summarizationFallbackThresholdPercent",
                        message: "Summarization fallback threshold (% of working budget):",
                        default: String(currentSettings.summarizationFallbackThresholdPercent),
                        theme: inquirerTheme,
                        when: (answers: { summarizationFallbackEnabled?: boolean }) =>
                            answers.summarizationFallbackEnabled === true,
                        validate: (input: string) =>
                            /^\d+$/.test(input) &&
                                Number(input) >= 1 &&
                                Number(input) <= 100
                                ? true
                                : "Must be a number between 1 and 100",
                    },
                ]);

                existingConfig.contextManagement = {
                    enabled: true,
                    tokenBudget: parseInt(answers.tokenBudget),
                    scratchpadEnabled: answers.scratchpadEnabled,
                    forceScratchpadEnabled:
                        answers.forceScratchpadEnabled ?? currentSettings.forceScratchpadEnabled,
                    forceScratchpadThresholdPercent: parseInt(
                        answers.forceScratchpadThresholdPercent ??
                            String(currentSettings.forceScratchpadThresholdPercent)
                    ),
                    utilizationWarningEnabled: answers.utilizationWarningEnabled,
                    utilizationWarningThresholdPercent: parseInt(
                        answers.utilizationWarningThresholdPercent ??
                            String(currentSettings.utilizationWarningThresholdPercent)
                    ),
                    summarizationFallbackEnabled: answers.summarizationFallbackEnabled,
                    summarizationFallbackThresholdPercent: parseInt(
                        answers.summarizationFallbackThresholdPercent ??
                            String(currentSettings.summarizationFallbackThresholdPercent)
                    ),
                };
            } else {
                existingConfig.contextManagement = {
                    ...currentSettings,
                    enabled: false,
                };
            }
            delete existingConfig.compression;

            await configService.saveGlobalConfig(existingConfig);
            console.log(chalk.green("✓") + chalk.bold(" Context management config saved."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure context management: ${error}`));
            process.exitCode = 1;
        }
    });
