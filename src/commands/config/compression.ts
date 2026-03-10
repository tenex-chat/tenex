import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const compressionCommand = new Command("compression")
    .description("Configure conversation compression — token limits and sliding window")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const comp = existingConfig.compression || {};

            console.log(`  Enabled: ${comp.enabled ?? true}`);
            console.log(`  Token threshold: ${comp.tokenThreshold ?? 50000}`);
            console.log(`  Token budget: ${comp.tokenBudget ?? 40000}`);
            console.log(`  Sliding window: ${comp.slidingWindowSize ?? 50} messages\n`);

            const { enabled } = await inquirer.prompt([{
                type: "confirm",
                name: "enabled",
                message: "Enable compression?",
                default: comp.enabled ?? true,
                theme: inquirerTheme,
            }]);

            if (enabled) {
                const answers = await inquirer.prompt([
                    {
                        type: "input",
                        name: "tokenThreshold",
                        message: "Token threshold:",
                        default: String(comp.tokenThreshold ?? 50000),
                        theme: inquirerTheme,
                        validate: (input: string) => /^\d+$/.test(input) || "Must be a number",
                    },
                    {
                        type: "input",
                        name: "tokenBudget",
                        message: "Token budget:",
                        default: String(comp.tokenBudget ?? 40000),
                        theme: inquirerTheme,
                        validate: (input: string) => /^\d+$/.test(input) || "Must be a number",
                    },
                    {
                        type: "input",
                        name: "slidingWindowSize",
                        message: "Sliding window size (messages):",
                        default: String(comp.slidingWindowSize ?? 50),
                        theme: inquirerTheme,
                        validate: (input: string) => /^\d+$/.test(input) || "Must be a number",
                    },
                ]);

                existingConfig.compression = {
                    enabled: true,
                    tokenThreshold: parseInt(answers.tokenThreshold),
                    tokenBudget: parseInt(answers.tokenBudget),
                    slidingWindowSize: parseInt(answers.slidingWindowSize),
                };
            } else {
                existingConfig.compression = {
                    ...comp,
                    enabled: false,
                };
            }

            await configService.saveGlobalConfig(existingConfig);
            console.log(chalk.green("✓") + chalk.bold(" Compression config saved."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure compression: ${error}`));
            process.exitCode = 1;
        }
    });
