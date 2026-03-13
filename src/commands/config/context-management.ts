import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const contextManagementCommand = new Command("context-management")
    .alias("context")
    .alias("compression")
    .description("Configure request-time context management — sliding window and scratchpad strategies")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const contextManagement = {
                ...existingConfig.compression,
                ...existingConfig.contextManagement,
            };

            console.log(`  Enabled: ${contextManagement.enabled ?? true}`);
            console.log(`  Token budget: ${contextManagement.tokenBudget ?? 40000}`);
            console.log(`  Sliding window: ${contextManagement.slidingWindowSize ?? 50} messages`);
            console.log(`  Sliding window strategy: ${contextManagement.slidingWindowEnabled ?? true}`);
            console.log(`  Scratchpad strategy: ${contextManagement.scratchpadEnabled ?? true}\n`);

            const { enabled } = await inquirer.prompt([{
                type: "confirm",
                name: "enabled",
                message: "Enable context management?",
                default: contextManagement.enabled ?? true,
                theme: inquirerTheme,
            }]);

            if (enabled) {
                const answers = await inquirer.prompt([
                    {
                        type: "input",
                        name: "tokenBudget",
                        message: "Token budget:",
                        default: String(contextManagement.tokenBudget ?? 40000),
                        theme: inquirerTheme,
                        validate: (input: string) => /^\d+$/.test(input) || "Must be a number",
                    },
                    {
                        type: "input",
                        name: "slidingWindowSize",
                        message: "Sliding window size (messages):",
                        default: String(contextManagement.slidingWindowSize ?? 50),
                        theme: inquirerTheme,
                        validate: (input: string) => /^\d+$/.test(input) || "Must be a number",
                    },
                    {
                        type: "confirm",
                        name: "slidingWindowEnabled",
                        message: "Enable sliding window trimming?",
                        default: contextManagement.slidingWindowEnabled ?? true,
                        theme: inquirerTheme,
                    },
                    {
                        type: "confirm",
                        name: "scratchpadEnabled",
                        message: "Enable scratchpad strategy/tool?",
                        default: contextManagement.scratchpadEnabled ?? true,
                        theme: inquirerTheme,
                    },
                ]);

                existingConfig.contextManagement = {
                    enabled: true,
                    tokenBudget: parseInt(answers.tokenBudget),
                    slidingWindowSize: parseInt(answers.slidingWindowSize),
                    slidingWindowEnabled: answers.slidingWindowEnabled,
                    scratchpadEnabled: answers.scratchpadEnabled,
                };
            } else {
                existingConfig.contextManagement = {
                    ...contextManagement,
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
